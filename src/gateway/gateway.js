/**
 * gateway.js — Effy v3.5+v4 Gateway 메인 클래스.
 *
 * 단일 프로세스로 모든 것을 관리:
 * - 채널 어댑터 (Slack, Discord, Webhook)
 * - 바인딩 라우팅 (채널/유저 → 에이전트)
 * - 기능 라우팅 (키워드 → code/ops/knowledge/general)
 * - zero-hop 컨텍스트 조립 (메모리 → system prompt 직접 주입)
 * - Agent Runtime (Anthropic Agentic Loop, async/await — 메인 스레드에서 논블로킹)
 * - 세션 관리 + SessionIndexer
 *
 * v3.5 모듈:
 * - MessageCoalescer, CircuitBreaker, ModelRouter, BudgetGate, MemoryBulletin
 *
 * v4 Port 모듈:
 * - MemoryGraph (8 typed nodes + 5 edge types + importance scoring)
 * - MemorySearch (hybrid FTS5 + importance re-ranking)
 * - CompactionEngine (80% threshold context compression)
 * - Structured Logger
 * - Enhanced ToolExecutor (DB-backed tasks/incidents, graph-linked knowledge)
 *
 * 메시지 파이프라인:
 * 어댑터 → coalescer → middleware → binding match → modelRouter
 * → circuitBreaker → budgetGate → pool → context assemble → LLM → respond → persist
 */
const { config } = require('../config');
const { BindingRouter } = require('./binding-router');
const { AgentLoader } = require('./agent-loader');
const { WorkingMemory, episodic, semantic, entity } = require('../memory/manager');
const { buildContext, formatContextForLLM } = require('../memory/context');
const { runMiddleware } = require('../core/middleware');
const { classifyRequest } = require('../core/router');
const { ConcurrencyGovernor, SessionRegistry } = require('../core/pool');
const { runAgent } = require('../agents/runtime');
const { indexSession, setBulletin } = require('../memory/indexer');
const { RunLogger } = require('../shared/run-logger');
const { client: anthropicClient } = require('../shared/anthropic');
const { createLogger } = require('../shared/logger');

// v3.5 모듈
const { MessageCoalescer } = require('../core/coalescer');
const { CircuitBreaker } = require('../core/circuit-breaker');
const { ModelRouter } = require('../core/model-router');
const { BudgetGate } = require('../core/budget-gate');
const { MemoryBulletin } = require('../memory/bulletin');

// v4 Port 모듈
const { MemoryGraph } = require('../memory/graph');
const { MemorySearch } = require('../memory/search');
const { CompactionEngine } = require('../memory/compaction');

// Skills
const { getSkillRegistry } = require('../skills/registry');

// v3.6: Self-Improvement
const { getReflection, getOutcomeTracker } = require('../reflection');

const log = createLogger('gateway');

class Gateway {
  constructor() {
    // 에이전트 시스템
    const agents = config.agents?.list || [];
    const defaultAgent = agents.find(a => a.default)?.id || 'general';

    this.agentLoader = new AgentLoader(config.agents?.dir || './agents');
    this.bindingRouter = new BindingRouter(config.bindings || [], defaultAgent);
    this.agentConfigs = new Map(agents.map(a => [a.id, a]));

    // 세션 + 동시성
    this.governor = new ConcurrencyGovernor();
    this.sessions = new SessionRegistry(config.session.idleTimeoutMs);
    this.workingMemory = new WorkingMemory();

    // P-6: Agent Run Observability
    this.runLogger = new RunLogger();

    // ─── v3.5: 신규 모듈 초기화 ───
    this.coalescer = new MessageCoalescer();
    this.circuitBreaker = new CircuitBreaker();
    this.modelRouter = new ModelRouter();
    this.budgetGate = new BudgetGate();
    this.bulletin = new MemoryBulletin();

    // ─── v4 Port: Memory Graph + Search + Compaction ───
    this.memoryGraph = new MemoryGraph();
    // INFO-2: memorySearch는 Phase 2에서 search_knowledge 도구와 통합 예정
    // 현재 검색은 runtime.js → semantic.searchWithPools()가 담당
    this.memorySearch = new MemorySearch();
    this.compactionEngine = new CompactionEngine({ ...(config.compaction || {}), graph: this.memoryGraph });

    // Indexer에 bulletin 인스턴스 주입
    setBulletin(this.bulletin);

    // 채널 어댑터
    this.adapters = new Map();
    this.slackClient = null;

    // 세션 idle → SessionIndexer (중복 인덱싱 방지)
    this._indexingInProgress = new Set();
    this.sessions.onIdle(async (key, data) => {
      if (this._indexingInProgress.has(key)) return;
      this._indexingInProgress.add(key);
      try {
        const convKey = data.conversationKey || key;
        const messages = this.workingMemory.get(convKey);
        if (messages.length > 0) {
          try {
            await indexSession(key, data, messages);
          } catch (err) {
            log.error(`IndexSession error: ${err.message}`);
          }
          this.workingMemory.clear(convKey);
        }
      } finally {
        this._indexingInProgress.delete(key);
      }
    });
  }

  /** 채널 어댑터 등록. */
  registerAdapter(name, adapter) {
    this.adapters.set(name, adapter);
    if (name === 'slack') {
      this.slackClient = adapter.client;
      this.circuitBreaker.setSlackClient(adapter.client);
    }
  }

  /**
   * ★ 메인 메시지 파이프라인 — 모든 채널 어댑터에서 호출됨.
   *
   * async/await 기반: 100명이 동시에 요청해도 각 LLM 호출이
   * 네트워크 I/O 대기 중 이벤트 루프를 양보하므로 블로킹 없이 병렬 처리.
   *
   * @param {object} msg - NormalizedMessage
   * @param {object} adapter - 응답 전송용 어댑터
   */
  async onMessage(msg, adapter) {
    let userId, channelId, acquired = false;

    try {
      // ─── ① 미들웨어 ───
      const mw = runMiddleware({
        user: msg.sender.id,
        text: msg.content.text,
        bot_id: msg.sender.isBot ? 'bot' : undefined,
      });

      if (!mw.pass) {
        if (mw.reason === 'rate_limited') {
          await adapter.reply(msg, '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
        }
        return;
      }

      // ─── ①.5 v4.0: 온보딩 인터셉트 (조직 + 개인) ───
      userId = msg.sender.id;  // R5-BUG-3: mw.userId는 undefined — msg.sender.id 사용
      try {
        const onboarding = require('../organization/onboarding');
        const { isAdmin } = require('../shared/auth');

        // 진행 중인 온보딩이면 계속 처리 (admin/일반 사용자 모두)
        if (onboarding.isOnboarding(userId)) {
          const session = onboarding.getSession(userId);
          const response = onboarding.processInput(userId, msg.content.text);
          if (response) {
            await adapter.reply(msg, response);
            // 온보딩 완료 + pending message가 있으면 원래 질문을 이어서 처리
            if (session?.pendingMessage && session.pendingMessage.length > 2 && session.step?.endsWith('_done')) {
              msg.content.text = session.pendingMessage;
              // 파이프라인 계속 진행 (return 안 함)
            } else {
              return;
            }
          }
        }

        // Admin: 조직 온보딩 (최초 or "조직 설정" 키워드)
        if (isAdmin(userId)) {
          if (/조직\s*설정|org\s*setup/i.test(msg.content.text)) {
            await adapter.reply(msg, onboarding.startOrgOnboarding(userId));
            return;
          }
          if (onboarding.needsOrgOnboarding()) {
            await adapter.reply(msg, onboarding.startOrgOnboarding(userId));
            return;
          }
        }

        // 모든 사용자: 개인 온보딩 (Entity에 role 없으면 자동 시작)
        if (onboarding.needsPersonalOnboarding(userId)) {
          const displayName = msg.sender?.name || '';
          const userMessage = msg.content.text || '';
          // 사용자가 질문/요청을 먼저 보냈으면 알려주기
          const pendingNotice = userMessage.length > 2
            ? `\n\n💬 말씀하신 내용은 프로필 설정 후 바로 답변드리겠습니다!`
            : '';
          await adapter.reply(msg, onboarding.startPersonalOnboarding(userId, { displayName, pendingMessage: userMessage }) + pendingNotice);
          return;
        }

        // "내 프로필 수정" 키워드 → 개인 온보딩 재시작
        if (/내\s*프로필\s*(수정|설정)|my\s*profile/i.test(msg.content.text)) {
          const displayName = msg.sender?.name || '';
          await adapter.reply(msg, onboarding.startPersonalOnboarding(userId, { displayName }));
          return;
        }
      } catch { /* onboarding optional */ }

      // ─── ①.5.5 Help 명령 인터셉트 ───
      try {
        const { isHelpCommand, getHelpMessage } = require('../features/help');
        if (isHelpCommand(msg.content.text)) {
          await adapter.reply(msg, getHelpMessage());
          return;
        }
      } catch { /* help optional */ }

      // ─── ①.6 v4.0: NL Config 인터셉트 ───
      try {
        const { detectConfigCommand, executeConfigCommand } = require('../features/nl-config');
        const cmd = detectConfigCommand(msg.content.text);
        if (cmd.matched) {
          const result = executeConfigCommand(cmd.handler, cmd.match, userId, cmd.severity);
          await adapter.reply(msg, result);
          return;
        }
      } catch { /* nl-config optional */ }

      // ─── ② 바인딩 라우팅 (채널 → 에이전트 결정) ───
      // BUG-3 fix: DM에서 "@에이전트명" 접두어 → msg 원본 mutation 대신 별도 변수 사용
      let dmAgentOverride = null;
      let effectiveText = msg.content.text;
      if (msg.metadata.isDM) {
        const agentMatch = effectiveText.match(/^@([\w-]+)\s+/);
        if (agentMatch && this.agentConfigs.has(agentMatch[1])) {
          dmAgentOverride = agentMatch[1];
          effectiveText = effectiveText.replace(/^@[\w-]+\s+/, '').trim();
        }
      }
      const { agentId: boundAgentId } = this.bindingRouter.match(msg);
      const agentId = dmAgentOverride || boundAgentId;

      // v4.0: Slack 첨부파일 텍스트 추출 → effectiveText에 append
      if (msg.content.attachments?.length > 0) {
        try {
          const { extractFileContents, formatFilesForContext } = require('./file-handler');
          const botToken = config.channels?.slack?.botToken;
          const fileContents = await extractFileContents(msg.content.attachments, botToken);
          const fileText = formatFilesForContext(fileContents);
          if (fileText) effectiveText += fileText;
        } catch (fileErr) {
          log.debug('File extraction skipped', { error: fileErr.message });
        }
      }

      // ─── ③ 기능 라우팅 (키워드 → code/ops/knowledge/general) ───
      const routing = classifyRequest(
        { text: effectiveText, user: msg.sender.id, channel: msg.channel.channelId, thread_ts: msg.channel.threadId, ts: msg.id },
        {
          isDM: msg.metadata.isDM,
          isMention: msg.metadata.isMention,
          isThreadFollowUp: !!msg.channel.threadId,
        }
      );

      // ─── ③.5 v3.6.2: ModelRouter — 5단계 모델 결정 (Agent-Level 4-Tier) ───
      const modelRouting = this.modelRouter.route({
        processType: 'channel',
        agentId,
        functionType: routing.functionType,
        text: effectiveText,
      });

      userId = msg.sender.id;
      channelId = msg.channel.channelId;
      const threadId = msg.channel.threadId;

      // ─── ④ v3.5: CircuitBreaker 체크 ───
      if (this.circuitBreaker.isDisabled(agentId)) {
        await adapter.reply(msg, `에이전트 '${agentId}'가 일시적으로 비활성화되었습니다. 잠시 후 다시 시도해주세요.`);
        return;
      }

      // ─── ④.5 동시성 체크 ───
      acquired = await this.governor.waitForSlot(userId, channelId);
      if (!acquired) {
        await adapter.reply(msg, '현재 처리 중인 요청이 많습니다. 잠시 후 다시 시도해주세요.');
        return;
      }

      // ─── ⑤ 세션 터치 ───
      const sessionKey = `${agentId}:${userId}:${channelId}:${threadId || msg.id}`;
      this.sessions.touch(sessionKey, {
        userId,
        channelId,
        threadTs: threadId,
        agentType: agentId,
        functionType: routing.functionType,
        conversationKey: sessionKey,
      });

      // ─── ⑥ L1 Working Memory ───
      this.workingMemory.add(sessionKey, { role: 'user', content: effectiveText });

      // ─── ⑥.5 P-1: 장기 대화 요약 (LIGHT 제외) ───
      if (routing.budgetProfile !== 'LIGHT') {
        await this.workingMemory.maybeSummarize(sessionKey, anthropicClient, config.anthropic.defaultModel);
      }

      // ─── ⑥.7 v4 Port: CompactionEngine — 80% 초과 시 메모리 추출 + 그래프 저장 ───
      try {
        const workingMsgs = this.workingMemory.get(sessionKey);
        const contextLimit = config.compaction?.contextLimit || 100000;
        if (this.compactionEngine.needsCompaction(workingMsgs, contextLimit)) {
          log.info('Compaction triggered', { session: sessionKey, msgCount: workingMsgs.length });
          const compactionModel = config.compaction?.model || config.anthropic?.defaultModel || 'claude-haiku-4-5-20251001';
          const { summary, extractedMemories, keptMessages } = await this.compactionEngine.compact(
            workingMsgs, anthropicClient, compactionModel,
            { channelId, userId }
          );
          // 압축된 메시지로 교체: 요약을 assistant role로 삽입 (연속 user turn 방지)
          if (summary) {
            this.workingMemory.replace(sessionKey, [
              { role: 'assistant', content: `[Context Summary]\n${summary}` },
              ...keptMessages,
            ]);
            log.info('Compaction applied', { kept: keptMessages.length, memories: extractedMemories.length });
          }
        }
      } catch (compErr) {
        log.warn('Compaction skipped', { error: compErr.message });
      }

      // ─── ⑥.9 v3.6: Reflection — 교정 감지 + Outcome 추적 ───
      let correctionResult = { detected: false, corrections: [], score: 0 };
      let outcomeResult = { sentiment: 'neutral', score: 0 };
      try {
        const reflection = getReflection();
        if (reflection) {
          // 이전 assistant 응답 가져오기 (교정 맥락)
          const prevMsgs = this.workingMemory.get(sessionKey);
          const lastAssistant = prevMsgs?.slice().reverse().find(m => m.role === 'assistant');

          // 1. 교정 패턴 감지
          correctionResult = reflection.detectCorrection(effectiveText, sessionKey, {
            agentId,
            userId,
            channelId,
            previousAgentResponse: lastAssistant?.content,
          });

          // 2. 교정 감지 시 → Lesson 승격 (사용자가 올바른 방향을 제시한 것으로 간주)
          if (correctionResult.detected) {
            reflection.promoteCorrection(sessionKey, effectiveText, { agentId, userId, channelId });
          }

          // 3. Outcome 추적 (이전 응답에 대한 피드백 신호)
          outcomeResult = reflection.detectOutcome(effectiveText);
        }
      } catch (reflErr) {
        log.warn(`Reflection error: ${reflErr.message}`);
      }

      // ─── ⑦ L2 Episodic 저장 ───
      episodic.save(sessionKey, userId, channelId, threadId || null, 'user', effectiveText, agentId, routing.functionType);

      // ─── ⑧ L4 Entity 업데이트 ───
      entity.upsert('user', userId, msg.sender.name || '', {});
      if (channelId) {
        entity.upsert('channel', channelId, '', {});
        entity.addRelationship('user', userId, 'channel', channelId, 'active_in');
      }

      // ─── ⑨ Context Assembler (zero-hop) ★ ───
      const agentConfig = this.agentConfigs.get(agentId);
      const accessiblePools = agentConfig?.memory?.shared_read || ['team'];
      const writablePools = agentConfig?.memory?.shared_write || ['team'];

      const memoryCtx = await buildContext({
        userId,
        channelId,
        conversationKey: sessionKey,
        text: effectiveText,
        budgetProfile: routing.budgetProfile,
        channelMentions: routing.channelMentions || msg.content.mentions || [],
        workingMemory: this.workingMemory,
        accessiblePools,
      });

      const memoryPrompt = formatContextForLLM(memoryCtx);

      // ─── ⑨.5 v3.5: Bulletin 주입 (system prompt 상단) ───
      let bulletinText = '';
      try {
        bulletinText = await this.bulletin.get(channelId, userId);
      } catch (err) {
        log.warn(`Bulletin error: ${err.message}`);
      }

      const basePrompt = this.agentLoader.buildSystemPrompt(agentId, memoryPrompt);

      // ─── ⑨.6 Skills: 활성화된 스킬 지시문 주입 ───
      let skillPrompts = '';
      try {
        const skillReg = getSkillRegistry();
        if (skillReg.initialized) {
          skillPrompts = skillReg.getSkillPrompts(agentId);
        }
      } catch (_) { /* skill registry not initialized — skip */ }

      // ─── ⑨.7 v3.6: Lesson 주입 (학습된 교훈 → system prompt) ───
      let lessonPrompt = '';
      try {
        const reflection = getReflection();
        if (reflection) {
          lessonPrompt = reflection.getLessonPrompt(agentId, 5);
        }
      } catch (_) { /* reflection not initialized — skip */ }

      // v4.0: Smart Search 컨텍스트 주입 (Expert Finder + Duplicate Detector + File Finder)
      let smartContext = '';
      try {
        const { buildSmartContext } = require('../features/smart-search');
        smartContext = buildSmartContext(effectiveText, { episodic, semantic, entity });
      } catch { /* smart-search optional */ }

      // v4.0: 조직 컨텍스트 주입
      let orgContext = '';
      try {
        const { buildOrgContext } = require('../organization/loader');
        orgContext = buildOrgContext();
      } catch { /* org loader not available */ }

      // Harness: Layered System Prompt — Progressive Disclosure
      // Layer 1 (Core): 에이전트 정체성 + 메모리 컨텍스트 (항상)
      // Layer 2 (Domain): 스킬 지시문 + 학습 교훈 + 조직 정보 (해당 시)
      // Layer 3 (Orientation): 브리핑 (채널 상태 요약)
      const systemPrompt = [
        // L1: Core Identity + Memory
        basePrompt,
        // L2: Domain Knowledge (skills + lessons + org + smart search)
        skillPrompts,
        lessonPrompt,
        orgContext,
        smartContext,
        // L3: Session Orientation (brief, changes frequently)
        bulletinText ? `<memory_bulletin>\n${bulletinText}\n</memory_bulletin>` : '',
      ].filter(Boolean).join('\n\n');

      // ─── ⑨.7 v3.6.2: BudgetGate — 비용 체크 + 모델 조정 ───
      let finalModel = modelRouting.model;
      let finalMaxTokens = modelRouting.maxTokens;
      let finalExtendedThinking = modelRouting.extendedThinking;
      let finalBudget = routing.budgetProfile;

      const budgetCheck = this.budgetGate.check(userId, channelId, 0, finalModel);
      if (budgetCheck.downgradeModel) {
        finalModel = budgetCheck.downgradeModel;
        // 모델 다운그레이드 시 maxTokens/ET도 해당 tier에 맞게 조정
        finalMaxTokens = Math.min(finalMaxTokens, 8192);
        finalExtendedThinking = null;
        log.info(`BudgetGate: ${budgetCheck.reason}`);
      }
      if (budgetCheck.adjustBudget) {
        finalBudget = budgetCheck.adjustBudget;
        log.info(`BudgetGate: budget capped → ${finalBudget}`);
      }

      log.info('Model routing', {
        agent: agentId, tier: modelRouting.tier,
        model: finalModel, maxTokens: finalMaxTokens,
        extendedThinking: !!finalExtendedThinking,
        complexity: modelRouting.budgetHint,
      });

      // ─── ⑩ Agent Runtime (async/await — 메인 스레드에서 논블로킹) ───
      const startMs = Date.now();
      const workingMessages = this.workingMemory.get(sessionKey);
      if (!workingMessages || workingMessages.length === 0) {
        log.warn(`No working messages for session: ${sessionKey}`);
        await adapter.reply(msg, '대화 히스토리를 로드할 수 없습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      const recentMessages = workingMessages.map(m => ({ role: m.role, content: m.content }));

      let result;
      try {
        result = await runAgent({
          systemPrompt,
          messages: recentMessages,
          functionType: routing.functionType,
          agentId,
          model: finalModel,
          maxTokens: finalMaxTokens,              // v3.6.2: per-tier maxTokens
          extendedThinking: finalExtendedThinking, // v3.6.2: tier4 Extended Thinking
          slackClient: this.slackClient,
          userId,
          sessionId: sessionKey,
          accessiblePools,
          writablePools,
          channelId,
          threadId,
          graph: this.memoryGraph,  // WARN-2: DI — MemoryGraph 싱글톤 공유
          // v4.0: 스트리밍 응답 — adapter에 replyStream이 있으면 전달
          streamAdapter: adapter.replyStream ? adapter : null,
          _originalMsg: msg,
        });

        this.circuitBreaker.recordSuccess(agentId);
      } catch (err) {
        this.circuitBreaker.recordError(agentId, err.message);
        this.modelRouter.recordModelError(finalModel);
        // Harness: 에러 이벤트 SSE 푸시
        try {
          const { broadcastSSE } = require('../dashboard/router');
          broadcastSSE('activity', {
            time: new Date().toTimeString().slice(0, 5),
            agent: agentId, icon: '⚠️',
            detail: `Error: ${err.message?.slice(0, 80)}`,
            tier: (modelRouting.tier || 'tier1').replace('tier', 'T'),
          });
        } catch { /* dashboard optional */ }
        throw err;
      }

      // ─── ⑪ 응답 전송 + 메모리 저장 ───
      if (result.text) {
        await adapter.reply(msg, result.text);
        this.workingMemory.add(sessionKey, { role: 'assistant', content: result.text });
        episodic.save(sessionKey, userId, channelId, threadId || null, 'assistant', result.text, agentId, routing.functionType);
      }

      const durationMs = Date.now() - startMs;
      log.info(`trace=${mw.traceId} agent=${agentId} func=${routing.functionType} budget=${finalBudget} model=${result.model} tokens=${result.inputTokens}+${result.outputTokens} iter=${result.iterations} ${durationMs}ms`);

      // ─── Harness: Dashboard SSE 실시간 푸시 ───
      try {
        const { broadcastSSE } = require('../dashboard/router');
        broadcastSSE('activity', {
          time: new Date().toTimeString().slice(0, 5),
          agent: agentId,
          icon: result.iterations > 1 ? '🔧' : '💬',
          detail: result.iterations > 1
            ? `${result.iterations} tool calls (${result.inputTokens + result.outputTokens} tokens)`
            : `응답 완료 (${result.outputTokens} tokens)`,
          tier: (modelRouting.tier || 'tier1').replace('tier', 'T'),
        });
      } catch { /* dashboard optional */ }

      // ─── ⑫ P-6: Run Logger + v3.6 Outcome Tracking ───
      const runEntry = {
        traceId: mw.traceId,
        agentId,
        functionType: routing.functionType,
        budgetProfile: finalBudget,
        model: result.model,
        userId,
        channelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        iterations: result.iterations,
        durationMs,
      };

      try {
        const tracker = getOutcomeTracker();
        if (tracker) {
          tracker.recordOutcome(runEntry, {
            sentiment: outcomeResult.sentiment,
            correctionDetected: correctionResult.detected,
            correctionScore: correctionResult.score,
          });
        } else {
          this.runLogger.log(runEntry);
        }
      } catch (_) {
        this.runLogger.log(runEntry); // 폴백: 기존 로거로
      }

      // ─── Harness: Session Summary → MemoryGraph ───
      // Anthropic 패턴: 세션 핵심 활동을 구조화된 기록으로 보관
      // 다음 세션에서 에이전트 오리엔테이션에 사용
      if (this.memoryGraph && result.iterations > 1) {
        try {
          this.memoryGraph.create({
            type: 'fact',
            content: `[Session] Agent=${agentId} | ${result.iterations} tool calls | Model=${result.model} | ${durationMs}ms | Budget=${finalBudget}`,
            sourceChannel: channelId,
            sourceUser: userId,
            importance: 0.3,
            metadata: { source: 'session_summary', agentId, traceId: mw.traceId },
          });
        } catch { /* non-critical */ }
      }

    } catch (err) {
      log.error(`Pipeline error: ${err.message}`);
      // R4-WARN-1 fix: reply 실패 로깅 추가
      try { await adapter.reply(msg, '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'); } catch (replyErr) { log.error('Error reply failed', { error: replyErr.message }); }
    } finally {
      if (acquired) this.governor.release(userId, channelId);
    }
  }
}

module.exports = { Gateway };
