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
const { UserProfileBuilder } = require('../memory/user-profile');

// v4.0: Session Recovery
const { SessionRecoveryManager } = require('../core/session-recovery');

// Skills
const { getSkillRegistry } = require('../skills/registry');

// v3.6: Self-Improvement
const { getReflection, getOutcomeTracker } = require('../reflection');

// v4.0: Branch Manager (병렬 사고)
const { BranchManager } = require('../core/branch-manager');

// Phase 4: Strangler Fig — pipeline dispatch
const { createGatewayPipeline } = require('./gateway-pipeline');

const log = createLogger('gateway');

/**
 * EFFY_GATEWAY_V2 Feature Flag.
 *
 * false (default): 기존 모놀리식 onMessage() 실행
 * true:            gateway-pipeline.js + gateway-steps.js 파이프라인 실행
 *
 * 전환: EFFY_GATEWAY_V2=true 환경변수 설정
 * 롤백: 환경변수 제거 또는 false (코드 변경 불필요)
 */
const GATEWAY_V2_ENABLED = process.env.EFFY_GATEWAY_V2 === 'true';

class Gateway {
  constructor({ stateBridge } = {}) {
    // 에이전트 시스템
    const agents = config.agents?.list || [];
    const defaultAgent = agents.find(a => a.default)?.id || 'general';

    this.agentLoader = new AgentLoader(config.agents?.dir || './agents');
    this.bindingRouter = new BindingRouter(config.bindings || [], defaultAgent);
    this.agentConfigs = new Map(agents.map(a => [a.id, a]));

    // 세션 + 동시성 — use stateBridge instances if provided to avoid dead duplicates
    this.governor = stateBridge?.concurrencyGovernor || new ConcurrencyGovernor();
    this.sessions = new SessionRegistry(config.session.idleTimeoutMs);
    this.workingMemory = stateBridge?.workingMemory || new WorkingMemory();

    // P-6: Agent Run Observability
    this.runLogger = new RunLogger();

    // ─── v3.5: 신규 모듈 초기화 ───
    this.coalescer = new MessageCoalescer();
    this.circuitBreaker = new CircuitBreaker();
    this.modelRouter = new ModelRouter();
    this.budgetGate = new BudgetGate();
    this.bulletin = new MemoryBulletin();

    // ─── v4.0: Branch Manager (병렬 사고) ───
    // R1-008 fix: V2 파이프라인 또는 branch 활성화 시에만 초기화
    if (config.branch?.enabled === true || GATEWAY_V2_ENABLED) {
      this.branchManager = new BranchManager({
        maxBranchesPerSession: (config.branch?.maxBranchesPerSession) || 3,
        branchTimeoutMs: (config.branch?.branchTimeoutMs) || 60000,
      });
    } else {
      this.branchManager = null;
    }

    // ─── v4 Port: Memory Graph + Search + Compaction ───
    this.memoryGraph = new MemoryGraph();
    // INFO-2: memorySearch는 Phase 2에서 search_knowledge 도구와 통합 예정
    // 현재 검색은 runtime.js → semantic.searchWithPools()가 담당
    this.memorySearch = new MemorySearch();
    this.compactionEngine = new CompactionEngine({ ...(config.compaction || {}), graph: this.memoryGraph });

    // ─── v4.0: User Profile Hydration ───
    this.userProfile = new UserProfileBuilder(this.memoryGraph, {
      cacheTtlMs: (config.userProfile?.cacheTtlMs) || 15 * 60 * 1000,
      maxMemoriesPerType: (config.userProfile?.maxMemoriesPerType) || 5,
    });

    // ─── v4.0: Session Recovery Manager ───
    this.sessionRecovery = new SessionRecoveryManager(this);

    // Indexer에 bulletin 인스턴스 주입
    setBulletin(this.bulletin);

    // Phase 4: Gateway v2 Pipeline (Strangler Fig)
    this._pipeline = null;
    if (GATEWAY_V2_ENABLED) {
      this._pipeline = createGatewayPipeline(this);
      log.info('Gateway v2 pipeline ENABLED — Strangler Fig mode');
    }

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
    // ─── Phase 4: Strangler Fig — V2 Pipeline Dispatch ───
    if (this._pipeline) {
      const pipelineResult = await this._pipeline.execute({ msg, adapter });
      if (!pipelineResult.success) {
        const failedStep = pipelineResult.stepTimings?.find(t => t.error);
        log.error('Pipeline v2 failed', {
          error: pipelineResult.error,
          failedStep: failedStep?.step,
          stepError: failedStep?.error,
          userId: pipelineResult.context?.userId,
          agentId: pipelineResult.context?.agentId,
        });
        try { await adapter.reply(msg, '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'); } catch { /* ignore */ }
      }
      // Release concurrency if acquired
      if (pipelineResult.context?.acquired) {
        this.governor.release(pipelineResult.context.userId, pipelineResult.context.channelId);
      }
      return;
    }

    // ─── Legacy V1 Pipeline (EFFY_GATEWAY_V2 !== 'true') ───
    let userId, channelId, acquired = false;
    let mw = null;

    try {
      // ─── ① 미들웨어 ───
      mw = runMiddleware({
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
        if (await onboarding.needsPersonalOnboarding(userId)) {
          // sender.name이 있으면 자동 프로필 저장 (온보딩 스킵)
          if (msg.sender?.name) {
            const displayName = msg.sender.name;
            const { _extractName } = require('../organization/onboarding');
            const name = _extractName ? _extractName(displayName) : displayName.split(/\s+/)[0];
            const deptMatch = displayName.match(/\)\s*(.+)$/);
            const department = deptMatch ? deptMatch[1].trim() : '';
            const { entity } = require('../memory/manager');
            await entity.upsert('user', userId, name || 'User', {
              role: 'member',
              department,
              expertise: [],
              autoRegistered: true,
            });
            onboarding.markOnboarded(userId);
            // 온보딩 스킵 — 바로 질문 처리 (파이프라인 계속 진행)
          } else {
            // 이름 정보 없는 채널 → 기존 온보딩
            const displayName = '';
            const userMessage = msg.content.text || '';
            const pendingNotice = userMessage.length > 2
              ? `\n\n💬 말씀하신 내용은 프로필 설정 후 바로 답변드리겠습니다!`
              : '';
            await adapter.reply(msg, onboarding.startPersonalOnboarding(userId, { displayName, pendingMessage: userMessage }) + pendingNotice);
            return;
          }
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
          const result = await executeConfigCommand(cmd.handler, cmd.match, userId, cmd.severity);
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

      // ─── External agent routing (LLM intent classification) ─────────────────
      // Effy가 Claude Haiku로 메시지 의도를 분석해서 적절한 외부 에이전트를 선택.
      let externalAgentOverride = null;
      const externalAgents = config.externalAgents || {};
      const extAgentEntries = Object.entries(externalAgents).filter(
        ([id]) => this.agentConfigs.has(id)
      );

      if (extAgentEntries.length > 0 && effectiveText && effectiveText.trim().length > 0) {
        try {
          const { createMessage } = require('../shared/llm-client');
          const classifierModel = config.anthropic?.models?.tier1?.id || 'claude-haiku-4-5-20251001';

          // 에이전트 목록 설명 생성
          const agentDescriptions = extAgentEntries.map(([id, cfg]) =>
            `- "${id}": ${cfg.description || cfg.label || id}`
          ).join('\n');

          // 최근 대화 컨텍스트를 분류기에 전달 (이전 대화의 연속 질문 감지)
          const wmEntries = (this.workingMemory?.get(`${msg.platform || 'slack'}:${userId}:${msg.channel?.channelId || ''}:${msg.channel?.threadId || ''}`) || []);
          const recentContext = wmEntries.slice(-6).map(m =>
            `${m.role === 'user' ? '사용자' : '에피'}: ${typeof m.content === 'string' ? m.content.substring(0, 100) : ''}`
          ).join('\n');
          const contextBlock = recentContext ? `\n\n최근 대화:\n${recentContext}` : '';

          const classifyResponse = await createMessage({
            model: classifierModel,
            max_tokens: 50,
            system: `당신은 메시지 분류기입니다. 사용자 메시지를 보고 어느 에이전트가 처리해야 하는지 판단하세요.

사용 가능한 외부 에이전트:
${agentDescriptions}

규칙:
- 해당 에이전트의 역할에 맞는 메시지면 에이전트 ID만 반환하세요.
- 이전 대화 맥락상 특정 에이전트의 연속 질문이면 해당 에이전트 ID를 반환하세요.
- 어느 에이전트에도 해당하지 않으면 "none"을 반환하세요.
- 에이전트 ID 또는 "none" 외에 다른 텍스트는 절대 출력하지 마세요.`,
            messages: [{ role: 'user', content: effectiveText + contextBlock }],
          });

          const classified = classifyResponse.content
            .filter(b => b.type === 'text')
            .map(b => b.text.trim())
            .join('');

          log.info('External agent classifier result', { classified, text: effectiveText.slice(0, 80) });

          // 대소문자 무시 매칭 — LLM이 소문자로 반환할 수 있음
          const matchedKey = Object.keys(externalAgents).find(
            key => key.toLowerCase() === classified.toLowerCase()
          );

          if (classified.toLowerCase() !== 'none' && matchedKey) {
            externalAgentOverride = matchedKey;
            log.info('External agent LLM classification', { agentId: matchedKey, text: effectiveText.slice(0, 80) });
          }
        } catch (classifyErr) {
          log.warn('External agent classification failed', { error: classifyErr.message });
        }
      }

      const agentId = dmAgentOverride || externalAgentOverride || boundAgentId;

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
      // 세션 격리: 스레드는 threadId로, 비스레드 메시지는 'main'으로 통합
      // (기존: msg.id 사용 → 메시지마다 세션 분리되어 대화 히스토리 누락)
      const sessionKey = `${agentId}:${userId}:${channelId}:${threadId || 'main'}`;
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
        try {
          await this.workingMemory.maybeSummarize(sessionKey, anthropicClient, config.anthropic.defaultModel);
        } catch (sumErr) {
          log.warn('Summarization failed (non-blocking)', { error: sumErr.message, sessionKey });
        }
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
            reflection.promoteCorrection(sessionKey, effectiveText, { agentId, userId, channelId }).catch(e => log.warn('promoteCorrection error', { error: e.message }));
          }

          // 3. Outcome 추적 (이전 응답에 대한 피드백 신호)
          outcomeResult = reflection.detectOutcome(effectiveText);
        }
      } catch (reflErr) {
        log.warn(`Reflection error: ${reflErr.message}`);
      }

      // ─── ⑦ L2 Episodic 저장 ───
      await episodic.save(sessionKey, userId, channelId, threadId || null, 'user', effectiveText, agentId, routing.functionType).catch(e => log.warn('episodic save error', { error: e.message }));

      // ─── ⑧ L4 Entity 업데이트 (Graph API 프로필 enrichment) ───
      this._enrichAndUpsertUser(userId, msg.sender.name);
      if (channelId) {
        entity.upsert('channel', channelId, '', {}).catch(e => log.warn('entity upsert error', { error: e.message }));
        entity.addRelationship('user', userId, 'channel', channelId, 'active_in').catch(e => log.warn('entity rel error', { error: e.message }));
      }

      // ─── ⑧.5 v4.0: Session Recovery (온디맨드) ───
      // 워킹 메모리가 비어있으면 L2에서 복구
      try {
        const workingMsgs = this.workingMemory.get(sessionKey);
        if (!workingMsgs || workingMsgs.length === 0) {
          const recoveredCount = await this.sessionRecovery.recoverSession(sessionKey);
          if (recoveredCount > 0) {
            log.info('Session recovered on-demand', { sessionKey, count: recoveredCount });
          }
        }
      } catch (recErr) {
        log.warn('Session recovery error', { sessionKey, error: recErr.message });
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
          lessonPrompt = await reflection.getLessonPrompt(agentId, 5);
        }
      } catch (_) { /* reflection not initialized — skip */ }

      // v4.0: Smart Search 컨텍스트 주입 (Expert Finder + Duplicate Detector + File Finder)
      let smartContext = '';
      try {
        const { buildSmartContext } = require('../features/smart-search');
        smartContext = await buildSmartContext(effectiveText, { episodic, semantic, entity });
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

      const budgetCheck = await this.budgetGate.check(userId, channelId, 0, finalModel);
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
          userProfile: this.userProfile,  // v4.0: UserProfileBuilder DI
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
        await episodic.save(sessionKey, userId, channelId, threadId || null, 'assistant', result.text, agentId, routing.functionType).catch(e => log.warn('episodic save error', { error: e.message }));
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
          await this.memoryGraph.create({
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
      log.error(`Pipeline error: ${err.message}`, { stack: err.stack?.split('\n').slice(0, 5).join('\n'), userId, channelId });
      // R4-WARN-1 fix: reply 실패 로깅 추가
      const refId = mw?.traceId || 'unknown';
      try { await adapter.reply(msg, `처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. (ref: ${refId})`); } catch (replyErr) { log.error('Error reply failed', { error: replyErr.message }); }
    } finally {
      if (acquired) this.governor.release(userId, channelId);
    }
  }

  /**
   * Graph API로 사용자 프로필을 enrichment하여 Entity에 저장.
   * 이미 부서/직급이 저장되어 있으면 스킵 (24시간 캐시).
   */
  _enrichAndUpsertUser(userId, fallbackName) {
    const { getUserProfileCached } = require('../shared/ms-graph');
    getUserProfileCached(userId).then(profile => {
      if (profile) {
        entity.upsert('user', userId, profile.displayName || fallbackName || '', {
          department: profile.department,
          jobTitle: profile.jobTitle,
          mail: profile.mail,
        }).catch(e => log.warn('entity upsert error', { error: e.message }));
      } else {
        entity.upsert('user', userId, fallbackName || '', {}).catch(e => log.warn('entity upsert error', { error: e.message }));
      }
    }).catch(() => {
      entity.upsert('user', userId, fallbackName || '', {}).catch(e => log.warn('entity upsert error', { error: e.message }));
    });
  }

  /** Pipeline v2 stats (only when EFFY_GATEWAY_V2=true). */
  getPipelineStats() {
    return this._pipeline ? this._pipeline.getStats() : null;
  }
}

module.exports = { Gateway, GATEWAY_V2_ENABLED };
