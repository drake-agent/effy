/**
 * gateway-steps.js — Pipeline step implementations for GatewayPipeline.
 *
 * Phase 4: Strangler Fig Pattern — gateway.onMessage()의 13단계 로직을
 * 개별 step 함수로 분리. EFFY_GATEWAY_V2=true일 때 파이프라인 실행에 사용.
 *
 * 각 step은 (ctx) => Promise<void> 시그니처이며,
 * ctx.halted = true 설정 시 파이프라인 조기 종료.
 */
const { config } = require('../config');
const { runMiddleware } = require('../core/middleware');
const { classifyRequest } = require('../core/router');
const { runAgent } = require('../agents/runtime');
const { episodic, semantic, entity } = require('../memory/manager');
const { buildContext, formatContextForLLM } = require('../memory/context');
const { indexSession, setBulletin } = require('../memory/indexer');
const { client: anthropicClient } = require('../shared/anthropic');
const { createLogger } = require('../shared/logger');

const log = createLogger('gateway:steps');

// ─── Step 1: Middleware (rate limit, bot filter) ───
async function middlewareStep(ctx) {
  const { msg, adapter } = ctx;
  const mw = runMiddleware({
    user: msg.sender.id,
    text: msg.content.text,
    bot_id: msg.sender.isBot ? 'bot' : undefined,
  });

  if (!mw.pass) {
    if (mw.reason === 'rate_limited') {
      await adapter.reply(msg, '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
    }
    ctx.halted = true;
    return;
  }

  ctx.traceId = mw.traceId;
  ctx.userId = msg.sender.id;
}

// ─── Step 1.5: Onboarding intercept ───
async function onboardingStep(ctx) {
  if (ctx.halted) return;
  const { msg, adapter, userId } = ctx;

  try {
    const onboarding = require('../organization/onboarding');
    const { isAdmin } = require('../shared/auth');

    if (onboarding.isOnboarding(userId)) {
      const session = onboarding.getSession(userId);
      const response = onboarding.processInput(userId, msg.content.text);
      if (response) {
        await adapter.reply(msg, response);
        if (session?.pendingMessage && session.pendingMessage.length > 2 && session.step?.endsWith('_done')) {
          msg.content.text = session.pendingMessage;
        } else {
          ctx.halted = true;
          return;
        }
      }
    }

    if (isAdmin(userId)) {
      if (/조직\s*설정|org\s*setup/i.test(msg.content.text)) {
        await adapter.reply(msg, onboarding.startOrgOnboarding(userId));
        ctx.halted = true;
        return;
      }
      if (onboarding.needsOrgOnboarding()) {
        await adapter.reply(msg, onboarding.startOrgOnboarding(userId));
        ctx.halted = true;
        return;
      }
    }

    if (await onboarding.needsPersonalOnboarding(userId)) {
      if (msg.sender?.name) {
        const displayName = msg.sender.name;
        const { _extractName } = require('../organization/onboarding');
        const name = _extractName ? _extractName(displayName) : displayName.split(/\s+/)[0];
        const deptMatch = displayName.match(/\)\s*(.+)$/);
        const department = deptMatch ? deptMatch[1].trim() : '';
        await entity.upsert('user', userId, name || 'User', {
          role: 'member', department, expertise: [], autoRegistered: true,
        });
        onboarding.markOnboarded(userId);
      } else {
        const userMessage = msg.content.text || '';
        const pendingNotice = userMessage.length > 2
          ? `\n\n💬 말씀하신 내용은 프로필 설정 후 바로 답변드리겠습니다!`
          : '';
        await adapter.reply(msg, onboarding.startPersonalOnboarding(userId, { displayName: '', pendingMessage: userMessage }) + pendingNotice);
        ctx.halted = true;
        return;
      }
    }

    if (/내\s*프로필\s*(수정|설정)|my\s*profile/i.test(msg.content.text)) {
      const displayName = msg.sender?.name || '';
      await adapter.reply(msg, onboarding.startPersonalOnboarding(userId, { displayName }));
      ctx.halted = true;
      return;
    }
  } catch { /* onboarding optional */ }
}

// ─── Step 1.55: Help command ───
async function helpStep(ctx) {
  if (ctx.halted) return;
  try {
    const { isHelpCommand, getHelpMessage } = require('../features/help');
    if (isHelpCommand(ctx.msg.content.text)) {
      await ctx.adapter.reply(ctx.msg, getHelpMessage());
      ctx.halted = true;
    }
  } catch { /* help optional */ }
}

// ─── Step 1.6: NL Config intercept ───
async function nlConfigStep(ctx) {
  if (ctx.halted) return;
  try {
    const { detectConfigCommand, executeConfigCommand } = require('../features/nl-config');
    const cmd = detectConfigCommand(ctx.msg.content.text);
    if (cmd.matched) {
      const result = await executeConfigCommand(cmd.handler, cmd.match, ctx.userId, cmd.severity);
      await ctx.adapter.reply(ctx.msg, result);
      ctx.halted = true;
    }
  } catch { /* nl-config optional */ }
}

// ─── Step 2: Binding Route (channel → agent) ───
async function bindingRouteStep(ctx) {
  if (ctx.halted) return;
  const { msg, gateway } = ctx;

  let dmAgentOverride = null;
  let effectiveText = msg.content.text;

  if (msg.metadata.isDM) {
    const agentMatch = effectiveText.match(/^@([\w-]+)\s+/);
    if (agentMatch && gateway.agentConfigs.has(agentMatch[1])) {
      dmAgentOverride = agentMatch[1];
      effectiveText = effectiveText.replace(/^@[\w-]+\s+/, '').trim();
    }
  }

  const { agentId: boundAgentId } = gateway.bindingRouter.match(msg);
  ctx.agentId = dmAgentOverride || boundAgentId;
  ctx.effectiveText = effectiveText;

  // v4.0: Slack file attachment text extraction
  if (msg.content.attachments?.length > 0) {
    try {
      const { extractFileContents, formatFilesForContext } = require('./file-handler');
      const botToken = config.channels?.slack?.botToken;
      const fileContents = await extractFileContents(msg.content.attachments, botToken);
      const fileText = formatFilesForContext(fileContents);
      if (fileText) ctx.effectiveText += fileText;
    } catch (fileErr) {
      log.debug('File extraction skipped', { error: fileErr.message });
    }
  }
}

// ─── Step 3: Function Route (keyword → code/ops/knowledge/general) ───
async function functionRouteStep(ctx) {
  if (ctx.halted) return;
  const { msg } = ctx;

  ctx.routing = classifyRequest(
    { text: ctx.effectiveText, user: msg.sender.id, channel: msg.channel.channelId, thread_ts: msg.channel.threadId, ts: msg.id },
    { isDM: msg.metadata.isDM, isMention: msg.metadata.isMention, isThreadFollowUp: !!msg.channel.threadId }
  );
}

// ─── Step 4: Model Route (5-tier model selection) ───
async function modelRouteStep(ctx) {
  if (ctx.halted) return;
  ctx.modelRouting = ctx.gateway.modelRouter.route({
    processType: 'channel',
    agentId: ctx.agentId,
    functionType: ctx.routing.functionType,
    text: ctx.effectiveText,
  });

  ctx.channelId = ctx.msg.channel.channelId;
  ctx.threadId = ctx.msg.channel.threadId;
}

// ─── Step 5: Circuit Breaker check ───
async function circuitBreakerStep(ctx) {
  if (ctx.halted) return;
  if (ctx.gateway.circuitBreaker.isDisabled(ctx.agentId)) {
    await ctx.adapter.reply(ctx.msg, `에이전트 '${ctx.agentId}'가 일시적으로 비활성화되었습니다. 잠시 후 다시 시도해주세요.`);
    ctx.halted = true;
  }
}

// ─── Step 6: Concurrency guard ───
async function concurrencyStep(ctx) {
  if (ctx.halted) return;
  ctx.acquired = await ctx.gateway.governor.waitForSlot(ctx.userId, ctx.channelId);
  if (!ctx.acquired) {
    await ctx.adapter.reply(ctx.msg, '현재 처리 중인 요청이 많습니다. 잠시 후 다시 시도해주세요.');
    ctx.halted = true;
  }
}

// ─── Step 7: Session touch ───
async function sessionStep(ctx) {
  if (ctx.halted) return;
  // 세션 격리: 스레드는 threadId로, 비스레드 메시지는 'main'으로 통합
  const sessionKey = `${ctx.agentId}:${ctx.userId}:${ctx.channelId}:${ctx.threadId || 'main'}`;
  ctx.sessionKey = sessionKey;

  ctx.gateway.sessions.touch(sessionKey, {
    userId: ctx.userId,
    channelId: ctx.channelId,
    threadTs: ctx.threadId,
    agentType: ctx.agentId,
    functionType: ctx.routing.functionType,
    conversationKey: sessionKey,
  });
}

// ─── Step 8: Working Memory + Summarize + Compaction ───
async function workingMemoryStep(ctx) {
  if (ctx.halted) return;
  const { sessionKey, effectiveText, routing, gateway } = ctx;
  const { workingMemory, compactionEngine, memoryGraph } = gateway;

  workingMemory.add(sessionKey, { role: 'user', content: effectiveText });

  // Long conversation summarization (skip LIGHT budget)
  if (routing.budgetProfile !== 'LIGHT') {
    await workingMemory.maybeSummarize(sessionKey, anthropicClient, config.anthropic.defaultModel);
  }

  // v4 Compaction
  try {
    const workingMsgs = workingMemory.get(sessionKey);
    const contextLimit = config.compaction?.contextLimit || 100000;
    if (compactionEngine.needsCompaction(workingMsgs, contextLimit)) {
      log.info('Compaction triggered', { session: sessionKey, msgCount: workingMsgs.length });
      const compactionModel = config.compaction?.model || config.anthropic?.defaultModel || 'claude-haiku-4-5-20251001';
      const { summary, extractedMemories, keptMessages } = await compactionEngine.compact(
        workingMsgs, anthropicClient, compactionModel,
        { channelId: ctx.channelId, userId: ctx.userId }
      );
      if (summary) {
        workingMemory.replace(sessionKey, [
          { role: 'assistant', content: `[Context Summary]\n${summary}` },
          ...keptMessages,
        ]);
        log.info('Compaction applied', { kept: keptMessages.length, memories: extractedMemories.length });
      }
    }
  } catch (compErr) {
    log.warn('Compaction skipped', { error: compErr.message });
  }

  // v3.6 Reflection — correction detection + outcome tracking
  ctx.correctionResult = { detected: false, corrections: [], score: 0 };
  ctx.outcomeResult = { sentiment: 'neutral', score: 0 };
  try {
    const { getReflection } = require('../reflection');
    const reflection = getReflection();
    if (reflection) {
      const prevMsgs = workingMemory.get(sessionKey);
      const lastAssistant = prevMsgs?.slice().reverse().find(m => m.role === 'assistant');

      ctx.correctionResult = reflection.detectCorrection(effectiveText, sessionKey, {
        agentId: ctx.agentId, userId: ctx.userId, channelId: ctx.channelId,
        previousAgentResponse: lastAssistant?.content,
      });

      if (ctx.correctionResult.detected) {
        reflection.promoteCorrection(sessionKey, effectiveText, {
          agentId: ctx.agentId, userId: ctx.userId, channelId: ctx.channelId,
        }).catch(e => log.warn('promoteCorrection error', { error: e.message }));
      }

      ctx.outcomeResult = reflection.detectOutcome(effectiveText);
    }
  } catch (reflErr) {
    log.warn(`Reflection error: ${reflErr.message}`);
  }
}

// ─── Step 9: Context Assembly (zero-hop) ───
async function contextAssembleStep(ctx) {
  if (ctx.halted) return;
  const { gateway, agentId, sessionKey, effectiveText, routing, channelId, userId, modelRouting } = ctx;
  const agentConfig = gateway.agentConfigs.get(agentId);
  const accessiblePools = agentConfig?.memory?.shared_read || ['team'];
  ctx.accessiblePools = accessiblePools;
  ctx.writablePools = agentConfig?.memory?.shared_write || ['team'];

  const memoryCtx = await buildContext({
    userId, channelId,
    conversationKey: sessionKey,
    text: effectiveText,
    budgetProfile: routing.budgetProfile,
    channelMentions: routing.channelMentions || ctx.msg.content.mentions || [],
    workingMemory: gateway.workingMemory,
    accessiblePools,
  });

  const memoryPrompt = formatContextForLLM(memoryCtx);

  // Bulletin
  let bulletinText = '';
  try { bulletinText = await gateway.bulletin.get(channelId, userId); } catch (err) { log.warn(`Bulletin error: ${err.message}`); }

  const basePrompt = gateway.agentLoader.buildSystemPrompt(agentId, memoryPrompt);

  // Skills
  let skillPrompts = '';
  try {
    const { getSkillRegistry } = require('../skills/registry');
    const skillReg = getSkillRegistry();
    if (skillReg.initialized) skillPrompts = skillReg.getSkillPrompts(agentId);
  } catch { /* skip */ }

  // Lessons
  let lessonPrompt = '';
  try {
    const { getReflection } = require('../reflection');
    const reflection = getReflection();
    if (reflection) lessonPrompt = await reflection.getLessonPrompt(agentId, 5);
  } catch { /* skip */ }

  // Smart Search
  let smartContext = '';
  try {
    const { buildSmartContext } = require('../features/smart-search');
    smartContext = await buildSmartContext(effectiveText, { episodic, semantic, entity });
  } catch { /* skip */ }

  // Org context
  let orgContext = '';
  try {
    const { buildOrgContext } = require('../organization/loader');
    orgContext = buildOrgContext();
  } catch { /* skip */ }

  // v4.0: User Profile Hydration
  let userProfileText = '';
  try {
    userProfileText = await gateway.userProfile.getProfileText(userId);
  } catch (profileErr) {
    log.warn('User profile hydration skipped', { error: profileErr.message });
  }

  ctx.systemPrompt = [
    basePrompt,
    skillPrompts, lessonPrompt, orgContext, smartContext,
    userProfileText ? `<user_profile>\n${userProfileText}\n</user_profile>` : '',
    bulletinText ? `<memory_bulletin>\n${bulletinText}\n</memory_bulletin>` : '',
  ].filter(Boolean).join('\n\n');

  // BudgetGate
  ctx.finalModel = modelRouting.model;
  ctx.finalMaxTokens = modelRouting.maxTokens;
  ctx.finalExtendedThinking = modelRouting.extendedThinking;
  ctx.finalBudget = routing.budgetProfile;
}

// ─── Step 10: Budget Gate ───
async function budgetGateStep(ctx) {
  if (ctx.halted) return;
  const { gateway, userId, channelId, finalModel, modelRouting } = ctx;

  const budgetCheck = await gateway.budgetGate.check(userId, channelId, 0, finalModel);
  if (budgetCheck.downgradeModel) {
    ctx.finalModel = budgetCheck.downgradeModel;
    ctx.finalMaxTokens = Math.min(ctx.finalMaxTokens, 8192);
    ctx.finalExtendedThinking = null;
    log.info(`BudgetGate: ${budgetCheck.reason}`);
  }
  if (budgetCheck.adjustBudget) {
    ctx.finalBudget = budgetCheck.adjustBudget;
    log.info(`BudgetGate: budget capped → ${ctx.finalBudget}`);
  }

  log.info('Model routing', {
    agent: ctx.agentId, tier: modelRouting.tier,
    model: ctx.finalModel, maxTokens: ctx.finalMaxTokens,
    extendedThinking: !!ctx.finalExtendedThinking,
    complexity: modelRouting.budgetHint,
  });
}

// ─── Step 11: Agent Runtime ───
async function agentRuntimeStep(ctx) {
  if (ctx.halted) return;
  const { gateway, sessionKey, msg, adapter, agentId, routing } = ctx;

  ctx.startMs = Date.now();
  const workingMessages = gateway.workingMemory.get(sessionKey);
  if (!workingMessages || workingMessages.length === 0) {
    log.warn(`No working messages for session: ${sessionKey}`);
    await adapter.reply(msg, '대화 히스토리를 로드할 수 없습니다. 잠시 후 다시 시도해주세요.');
    ctx.halted = true;
    return;
  }

  const recentMessages = workingMessages.map(m => ({ role: m.role, content: m.content }));

  try {
    ctx.result = await runAgent({
      systemPrompt: ctx.systemPrompt,
      messages: recentMessages,
      functionType: routing.functionType,
      agentId,
      model: ctx.finalModel,
      maxTokens: ctx.finalMaxTokens,
      extendedThinking: ctx.finalExtendedThinking,
      slackClient: gateway.slackClient,
      userId: ctx.userId,
      sessionId: sessionKey,
      accessiblePools: ctx.accessiblePools,
      writablePools: ctx.writablePools,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      graph: gateway.memoryGraph,
      userProfile: gateway.userProfile,  // v4.0: UserProfileBuilder DI
      streamAdapter: adapter.replyStream ? adapter : null,
      _originalMsg: msg,
    });
    gateway.circuitBreaker.recordSuccess(agentId);
  } catch (err) {
    gateway.circuitBreaker.recordError(agentId, err.message);
    gateway.modelRouter.recordModelError(ctx.finalModel);
    // Dashboard SSE error push
    try {
      const { broadcastSSE } = require('../dashboard/router');
      broadcastSSE('activity', {
        time: new Date().toTimeString().slice(0, 5),
        agent: agentId, icon: '⚠️',
        detail: `Error: ${err.message?.slice(0, 80)}`,
        tier: (ctx.modelRouting.tier || 'tier1').replace('tier', 'T'),
      });
    } catch { /* dashboard optional */ }
    throw err;
  }
}

// ─── Step 12: Respond + Memory Persist ───
async function respondStep(ctx) {
  if (ctx.halted) return;
  const { gateway, sessionKey, msg, adapter, agentId, routing, result, traceId, modelRouting } = ctx;

  if (result.text) {
    await adapter.reply(msg, result.text);
    gateway.workingMemory.add(sessionKey, { role: 'assistant', content: result.text });
    episodic.save(sessionKey, ctx.userId, ctx.channelId, ctx.threadId || null, 'assistant', result.text, agentId, routing.functionType)
      .catch(e => log.warn('episodic save error', { error: e.message }));
  }

  ctx.durationMs = Date.now() - ctx.startMs;
  log.info(`trace=${traceId} agent=${agentId} func=${routing.functionType} budget=${ctx.finalBudget} model=${result.model} tokens=${result.inputTokens}+${result.outputTokens} iter=${result.iterations} ${ctx.durationMs}ms`);
}

// ─── Step 13: Episodic Save (user message) ───
async function episodicSaveStep(ctx) {
  if (ctx.halted) return;
  episodic.save(ctx.sessionKey, ctx.userId, ctx.channelId, ctx.threadId || null, 'user', ctx.effectiveText, ctx.agentId, ctx.routing.functionType)
    .catch(e => log.warn('episodic save error', { error: e.message }));
}

// ─── Post: Entity Update ───
async function entityUpdatePost(ctx) {
  if (ctx.halted) return;
  try {
    const { getUserProfileCached } = require('../shared/ms-graph');
    const profile = await getUserProfileCached(ctx.userId);
    if (profile) {
      await entity.upsert('user', ctx.userId, profile.displayName || ctx.msg.sender?.name || '', {
        department: profile.department, jobTitle: profile.jobTitle, mail: profile.mail,
      });
    } else {
      await entity.upsert('user', ctx.userId, ctx.msg.sender?.name || '', {});
    }
  } catch {
    entity.upsert('user', ctx.userId, ctx.msg.sender?.name || '', {}).catch(() => {});
  }

  if (ctx.channelId) {
    entity.upsert('channel', ctx.channelId, '', {}).catch(() => {});
    entity.addRelationship('user', ctx.userId, 'channel', ctx.channelId, 'active_in').catch(() => {});
  }
}

// ─── Post: Dashboard SSE ───
async function dashboardSSEPost(ctx) {
  if (!ctx.result) return;
  try {
    const { broadcastSSE } = require('../dashboard/router');
    broadcastSSE('activity', {
      time: new Date().toTimeString().slice(0, 5),
      agent: ctx.agentId,
      icon: ctx.result.iterations > 1 ? '🔧' : '💬',
      detail: ctx.result.iterations > 1
        ? `${ctx.result.iterations} tool calls (${ctx.result.inputTokens + ctx.result.outputTokens} tokens)`
        : `응답 완료 (${ctx.result.outputTokens} tokens)`,
      tier: (ctx.modelRouting?.tier || 'tier1').replace('tier', 'T'),
    });
  } catch { /* dashboard optional */ }
}

// ─── Post: Outcome Tracking + Run Logger ───
async function outcomeTrackingPost(ctx) {
  if (!ctx.result) return;
  const { getOutcomeTracker } = require('../reflection');

  const runEntry = {
    traceId: ctx.traceId,
    agentId: ctx.agentId,
    functionType: ctx.routing.functionType,
    budgetProfile: ctx.finalBudget,
    model: ctx.result.model,
    userId: ctx.userId,
    channelId: ctx.channelId,
    inputTokens: ctx.result.inputTokens,
    outputTokens: ctx.result.outputTokens,
    iterations: ctx.result.iterations,
    durationMs: ctx.durationMs,
  };

  try {
    const tracker = getOutcomeTracker();
    if (tracker) {
      tracker.recordOutcome(runEntry, {
        sentiment: ctx.outcomeResult.sentiment,
        correctionDetected: ctx.correctionResult.detected,
        correctionScore: ctx.correctionResult.score,
      });
    } else {
      ctx.gateway.runLogger.log(runEntry);
    }
  } catch {
    ctx.gateway.runLogger.log(runEntry);
  }
}

// ─── Post: MemoryGraph session summary ───
async function sessionGraphPost(ctx) {
  if (!ctx.result || ctx.result.iterations <= 1) return;
  const { gateway } = ctx;
  if (!gateway.memoryGraph) return;

  try {
    await gateway.memoryGraph.create({
      type: 'fact',
      content: `[Session] Agent=${ctx.agentId} | ${ctx.result.iterations} tool calls | Model=${ctx.result.model} | ${ctx.durationMs}ms | Budget=${ctx.finalBudget}`,
      sourceChannel: ctx.channelId,
      sourceUser: ctx.userId,
      importance: 0.3,
      metadata: { source: 'session_summary', agentId: ctx.agentId, traceId: ctx.traceId },
    });
  } catch { /* non-critical */ }
}

// ─── Step registry — maps step names to functions ───
const STEP_REGISTRY = {
  // Core steps (user-facing latency path)
  middleware:       middlewareStep,
  onboarding:      onboardingStep,
  help:            helpStep,
  nlConfig:        nlConfigStep,
  bindingRoute:    bindingRouteStep,
  functionRoute:   functionRouteStep,
  modelRoute:      modelRouteStep,
  circuitBreaker:  circuitBreakerStep,
  concurrency:     concurrencyStep,
  session:         sessionStep,
  workingMemory:   workingMemoryStep,
  contextAssemble: contextAssembleStep,
  budgetGate:      budgetGateStep,
  agentRuntime:    agentRuntimeStep,
  respond:         respondStep,
  episodicSave:    episodicSaveStep,

  // Post-processing steps (non-blocking, after response)
  entityUpdate:    entityUpdatePost,
  dashboardSSE:    dashboardSSEPost,
  postProcess:     outcomeTrackingPost,
  bulletinInject:  sessionGraphPost,
};

module.exports = { STEP_REGISTRY };
