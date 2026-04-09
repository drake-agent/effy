/**
 * app.js — Effy v3.5+v4 Gateway 부트스트래퍼.
 *
 * 부팅 순서:
 * 1. 설정 검증 (effy.config.yaml)
 * 2. SQLite 초기화 + v4 마이그레이션
 * 2.5. DataSource Connector 초기화 (config.datasources)
 * 2.7. Skill Registry 초기화
 * 3. Gateway 인스턴스 생성
 * 4. 채널 어댑터 등록 + 시작
 * 4.5. v3.6: Reflection + Hybrid Committee 초기화 (Gateway RunLogger 공유)
 * 5. GitHub Webhook 서버 시작
 * 6. 상태 출력
 */
const { config, validate } = require('./config');
const db = require('./db');
const { Gateway } = require('./gateway/gateway');
const { SlackAdapter } = require('./gateway/adapters/slack');
const { startWebhookServer } = require('./github/webhook');
const { setBulletin } = require('./memory/indexer');
const { getRegistry } = require('./datasource/registry');
const { getSkillRegistry } = require('./skills/registry');
const { initReflection, getCommittee, destroyReflection } = require('./reflection');
const { createLogger } = require('./shared/logger');
const { GatewayStateBridge } = require('./gateway/state-adapters');
const { HealthCheck } = require('./gateway/health');

const log = createLogger('boot');

// ─── Process-level error handlers ───
process.on('unhandledRejection', (reason) => {
  log.warn('Unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — initiating shutdown', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

// SF-3: Graceful shutdown에서 참조 (TDZ 방지: IIFE보다 먼저 선언)
let gateway_ref = null;
let healthCheck_ref = null;
let purgeTimer_ref = null;
const SHUTDOWN_TIMEOUT_MS = 15000;

// ─── 부팅 ───
(async () => {
  try {
    // 1. 설정 검증
    validate();

    // 2. DB 초기화 + 마이그레이션 (SQLite 또는 PostgreSQL)
    await db.init();
    log.info('DB initialized: PostgreSQL');;

    // 2.5. DataSource Connector 초기화 (Gateway보다 먼저 — 도구 실행 시 참조)
    const dsRegistry = getRegistry();
    const datasources = config.datasources || [];
    if (datasources.length > 0) {
      await dsRegistry.init(datasources);
      log.info(`DataSource connectors initialized: ${dsRegistry.listConnectors('*').map(c => c.id).join(', ')}`);
    }

    // 2.7. Skill Registry 초기화 (BUG-2 fix: 항상 init — resolver 생성 보장)
    const skillRegistry = getSkillRegistry();
    const skillsConfig = config.skills || {};
    await skillRegistry.init(skillsConfig);
    if (skillRegistry.installed.size > 0) {
      log.info(`SkillRegistry initialized: ${skillRegistry.installed.size} skill(s) pre-installed`);
    } else {
      log.info('SkillRegistry initialized (on-demand mode)');
    }

    // 2.9. v4.0: State Bridge 초기화 (Redis or Local fallback)
    const stateBridge = new GatewayStateBridge({
      redis: config.redis || undefined,
      concurrency: config.concurrency,
      rateLimit: { windowMs: 60000, maxRequests: config.rateLimit?.maxPerMinute || 30 },
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 900000 },
      workingMemory: {
        maxEntries: config.memory?.workingMemory?.maxEntries || 50,
        ttlSec: (config.session?.idleTimeoutMs || 1800000) / 1000,
        summarizeThreshold: config.memory?.summarization?.threshold || 30,
        keepRecent: config.memory?.summarization?.keepRecent || 10,
        maxSummaryTokens: config.memory?.summarization?.maxSummaryTokens || 500,
      },
    });
    await stateBridge.initialize();
    log.info(`State bridge initialized: ${stateBridge.mode} mode`);

    // 2.95. v4.0: MCP Client 초기화 (optional — MCP 서버 미설정 시 graceful skip)
    try {
      const { getMCPClient } = require('./mcp/client');
      const mcpClient = getMCPClient();
      await mcpClient.initialize();
      log.info(`MCP client initialized: ${mcpClient.connections.size} server(s) connected`);
    } catch (mcpErr) {
      log.warn('MCP client init failed (non-critical)', { error: mcpErr.message });
    }

    // 2.96. OP-1: HealthCheck 인스턴스 생성 + 컴포넌트 등록
    const healthCheck = new HealthCheck();
    healthCheck_ref = healthCheck;

    // DB 헬스 체크 등록
    healthCheck.register('database', {
      check: async () => {
        try {
          const adapter = require('./db').getAdapter();
          await adapter.get('SELECT 1');
          return { ok: true, details: 'ping ok' };
        } catch (err) {
          return { ok: false, details: err.message };
        }
      },
      critical: true,
    });

    // Redis 헬스 체크 등록 (StateBridge가 Redis 모드일 때만)
    if (stateBridge.mode === 'redis') {
      healthCheck.register('redis', {
        check: async () => {
          try {
            await stateBridge.redis.ping();
            return { ok: true, details: 'ping ok' };
          } catch (err) {
            return { ok: false, details: err.message };
          }
        },
        critical: false,
      });
    }

    // 헬스 엔드포인트: 별도 미니 HTTP 서버 (포트 3101 또는 HEALTH_PORT)
    const healthPort = parseInt(process.env.HEALTH_PORT || '3101', 10);
    try {
      const http = require('http');
      const healthServer = http.createServer(async (req, res) => {
        try {
          if (req.url === '/health') {
            const result = healthCheck.check();
            res.writeHead(result.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (req.url === '/health/detailed') {
            const result = await healthCheck.checkDetailed();
            res.writeHead(result.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
          // OP-3: Prometheus metrics endpoint
          // To enable: npm install prom-client, then uncomment:
          // else if (req.url === '/metrics') {
          //   const { getMetrics } = require('./observability/prometheus');
          //   const prom = getMetrics();
          //   const metrics = await prom.getMetrics();
          //   res.writeHead(200, { 'Content-Type': prom.getContentType() });
          //   res.end(metrics);
          // }
          else {
            res.writeHead(404);
            res.end('Not Found');
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: err.message }));
        }
      });
      healthServer.listen(healthPort, () => {
        log.info(`Health endpoint on :${healthPort}/health`);
      });
      healthServer.unref();
    } catch (healthErr) {
      log.warn('Health server start failed (non-critical)', { error: healthErr.message });
    }

    // 3. Gateway 생성
    const gateway = new Gateway({ stateBridge });
    gateway_ref = gateway;

    // v3.5: Indexer에 Bulletin 인스턴스 주입
    if (gateway.bulletin) {
      setBulletin(gateway.bulletin);
    }
    log.info('Gateway created (v3.5+v4 modules active)');

    // ─── v4.0: Session Recovery (batch startup) ───
    // 최근 1시간 내 활성 세션의 워킹 메모리 미리 로드
    try {
      const recoverWithinMs = config.sessionRecovery?.recoverWithinMs || 3600000;
      const recoveredSessions = await gateway.sessionRecovery.recoverRecentSessions(recoverWithinMs);
      if (recoveredSessions > 0) {
        log.info(`Session Recovery: ${recoveredSessions} session(s) recovered on startup`);
      }
    } catch (recErr) {
      log.warn('Startup batch recovery failed (non-critical)', { error: recErr.message });
    }

    // 3.05. v3.9: TeamRegistry 초기화 — 에이전트 프로필 등록
    try {
      const { getTeamRegistry } = require('./agents/team-registry');
      const teamRegistry = getTeamRegistry();
      const agentList = config.agents?.list || [];
      teamRegistry.loadFromConfig(agentList);
      log.info(`TeamRegistry: ${agentList.length} agent(s) registered [${agentList.map(a => a.id).join(', ')}]`);
    } catch (teamRegErr) {
      log.warn('TeamRegistry init failed (non-critical)', { error: teamRegErr.message });
    }

    // 3.06. v3.9: AgentBus 초기화 — executeAgent 콜백 주입
    try {
      const { initAgentBus } = require('./agents/agent-bus');
      const { runAgent: runAgentFn } = require('./agents/runtime');
      const { client: anthropicClientRef } = require('./shared/anthropic');
      const { AgentLoader } = require('./gateway/agent-loader');
      const agentLoaderForBus = new AgentLoader(config.agents?.dir || './agents');

      // CommGraph + Mailbox (이미 gateway 내부에 있을 수 있음)
      let commGraph = null;
      let mailbox = null;
      try { commGraph = gateway.commGraph || require('./agents/comm-graph').getCommGraph(); } catch (_) {}
      try { mailbox = gateway.mailbox || require('./agents/mailbox').getMailbox(); } catch (_) {}

      // executeAgent: AgentBus.ask()가 호출할 때 실제로 에이전트를 실행하는 브릿지 함수
      const executeAgent = async (agentId, query, context = {}) => {
        const agentConfig = (config.agents?.list || []).find(a => a.id === agentId);
        if (!agentConfig) throw new Error(`Agent '${agentId}' not found in config`);

        // 에이전트의 시스템 프롬프트 조립
        const systemPrompt = agentLoaderForBus.buildSystemPrompt(agentId, '');
        const model = config.anthropic?.defaultModel || 'claude-haiku-4-5-20251001';

        const result = await runAgentFn({
          systemPrompt,
          messages: [{ role: 'user', content: query }],
          functionType: 'general',
          agentId,
          model,
          maxTokens: 4096,
          userId: context.fromAgent || 'system',
          sessionId: `bus:${context.fromAgent}→${agentId}`,
          accessiblePools: agentConfig.memory?.shared_read || ['team'],
          writablePools: agentConfig.memory?.shared_write || ['team'],
          channelId: context.channelId || '',
          threadId: context.threadId || '',
          _askDepth: context.depth || 0,
        });

        // 텍스트 응답 추출
        if (typeof result === 'string') return result;
        if (result?.response) return result.response;
        if (result?.text) return result.text;
        if (result?.content) {
          if (Array.isArray(result.content)) {
            return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          }
          return String(result.content);
        }
        return JSON.stringify(result);
      };

      initAgentBus({ commGraph, mailbox, executeAgent });
      if (!commGraph) log.warn('AgentBus: commGraph is null — agent communication will be unrestricted');
      if (!mailbox) log.warn('AgentBus: mailbox is null — async tell() will fail');
      log.info('AgentBus: initialized with executeAgent bridge');

      // 3.07. v3.9: DelegationTracer → AgentBus 이벤트 연결
      try {
        const { getDelegationTracer } = require('./agents/delegation-tracer');
        const tracer = getDelegationTracer();
        const { getAgentBus: getInitializedBus } = require('./agents/agent-bus');
        tracer.attachToBus(getInitializedBus());
        log.info('DelegationTracer: attached to AgentBus');
      } catch (tracerErr) {
        log.debug('DelegationTracer init skipped', { error: tracerErr.message });
      }
    } catch (busErr) {
      log.warn('AgentBus init failed (non-critical)', { error: busErr.message });
    }

    // 3.1. v4.0: Organization 구조 로드 → Entity Memory
    try {
      const { loadOrganization } = require('./organization/loader');
      const orgStats = await loadOrganization();
      if (orgStats.memberCount > 0) {
        log.info(`Organization loaded: ${orgStats.deptCount} depts, ${orgStats.memberCount} members, ${orgStats.projectCount} projects`);
      }
    } catch (e) { log.debug('Organization load failed', { error: e.message }); }

    // 4. Slack 어댑터
    let slackAdapter = null;
    if (config.channels?.slack?.enabled) {
      slackAdapter = new SlackAdapter(config.channels.slack, gateway);
      gateway.registerAdapter('slack', slackAdapter);
      await slackAdapter.start();
    }

    // 4.1. Teams 어댑터
    if (config.channels?.teams?.enabled) {
      try {
        const { TeamsAdapter } = require('./gateway/adapters/teams');
        const teamsAdapter = new TeamsAdapter(config.channels.teams, gateway);
        gateway.registerAdapter('teams', teamsAdapter);
        await teamsAdapter.start();
      } catch (teamsErr) {
        log.warn('Teams adapter failed (install botbuilder: npm install botbuilder)', { error: teamsErr.message });
      }
    }

    // 4.5. v3.6: Reflection (Self-Improvement) 초기화
    // BUG-5 fix: Gateway의 RunLogger 인스턴스를 공유 (이전에는 별도 인스턴스 생성)
    const { semantic, episodic, entity } = require('./memory/manager');
    const { AgentLoader } = require('./gateway/agent-loader');
    const reflectionConfig = config.reflection || {};
    const reflectionAgentLoader = new AgentLoader(config.agents?.dir || './agents');

    // VoteNotifier: 플랫폼 추상화 — Slack 어댑터가 있으면 SlackVoteNotifier 생성
    let notifier = null;
    const humanMembers = reflectionConfig.committee?.humanMembers || [];
    if (humanMembers.length > 0 && slackAdapter) {
      const { SlackVoteNotifier } = require('./reflection/vote-notifier');
      notifier = new SlackVoteNotifier(slackAdapter.client);
      log.info(`VoteNotifier: Slack (${humanMembers.length} human member(s))`);
    }

    try {
      initReflection({
        semantic,
        episodic,
        entity,
        runLogger: gateway.runLogger,  // BUG-5 fix: Gateway RunLogger 공유
        agentLoader: reflectionAgentLoader,
        notifier,
        config: reflectionConfig,
      });

      // Committee 액션 핸들러 등록 (Slack 앱에 투표 버튼 바인딩)
      const committee = getCommittee();
      if (committee && slackAdapter) {
        committee.registerActionHandlers(slackAdapter.app);
      }
    } catch (reflErr) {
      log.warn('Reflection init failed (non-critical)', { error: reflErr.message });
    }

    log.info(`Reflection initialized (nightly=${reflectionConfig.nightly?.enabled !== false ? 'ON' : 'OFF'}, committee=${reflectionConfig.committee?.enabled !== false ? 'ON' : 'OFF'}${humanMembers.length > 0 ? `, hybrid=ON(${humanMembers.length} humans)` : ''})`);

    // 5. GitHub Webhook + Dashboard
    if (config.github?.enabled && config.github?.webhookSecret) {
      const slackAdapterForWebhook = gateway.adapters.get('slack');
      startWebhookServer(slackAdapterForWebhook?.client || null);
      log.info(`GitHub webhook on :${config.gateway?.port || 3100}`);
    } else {
      // v5.1: GitHub webhook 없어도 Auth/Health용 HTTP 서버 시작
      try {
        const express = require('express');
        const authApp = express();
        const authPort = config.gateway?.port || 3100;

        // Health check
        authApp.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

        // OAuth routes
        const { authRouter } = require('./auth/routes');
        authApp.use(authRouter);

        authApp.listen(authPort, () => {
          log.info(`Auth/Health server listening on :${authPort} (no GitHub webhook)`);
        });
      } catch (authErr) {
        log.warn('Auth server failed to start', { error: authErr.message });
      }
    }

    // 5.1. Dashboard — Gateway/RunLogger 주입 + Teams Express 서버에 마운트
    try {
      const { dashboardRouter, injectDashboard } = require('./dashboard/router');
      injectDashboard(gateway, gateway.runLogger);

      // Teams 어댑터의 Express 서버에 대시보드 마운트 → hub-dev.fnco.co.kr/effy/dashboard
      const teamsAdapter = gateway.adapters.get('teams');
      if (teamsAdapter?.server) {
        const basePath = process.env.BASE_PATH || '';
        teamsAdapter.server.use(`${basePath}/dashboard`, dashboardRouter);
        log.info(`Dashboard mounted at ${basePath}/dashboard (on Teams Express :${teamsAdapter.port})`);
      }
    } catch (dashErr) {
      log.warn('Dashboard mount failed (non-critical)', { error: dashErr.message });
    }

    // 5.2. v4.0+v3.9: Observer (Ambient Intelligence) + ActionRouter 초기화
    try {
      const { getObserver } = require('./observer');
      const observer = getObserver();
      const slackAdapterInstance = gateway.adapters.get('slack');

      // v3.9: AgentBus + Entity Memory를 Observer에 전달 → ActionRouter가 사용
      let agentBusForObserver = null;
      try { agentBusForObserver = require('./agents/agent-bus').getAgentBus(); } catch (_) {}

      observer.init({
        config: config.observer || {},
        episodic,
        semantic,
        graph: gateway.memoryGraph,
        slackClient: slackAdapterInstance?.client || null,
        entity: entity || null,
        agentBus: agentBusForObserver,
      });
      log.info(`Observer: ${config.observer?.enabled !== false ? 'ON' : 'OFF'} (channels=${(config.observer?.channels || ['*']).join(',')}, actionRouter=ON)`);
    } catch (obsErr) {
      log.warn('Observer init failed (non-critical)', { error: obsErr.message });
    }

    // 5.3. v4.0: Morning Briefing 스케줄러
    try {
      const { MorningBriefing } = require('./features/morning-briefing');
      const slackAdapterForBriefing = gateway.adapters.get('slack');
      const observer = require('./observer').getObserver();
      const briefing = new MorningBriefing({
        slackClient: slackAdapterForBriefing?.client || null,
        insightStore: observer.insightStore,
        semantic,
        episodic,
      });
      briefing.start();
      log.info(`Morning Briefing: ${config.features?.briefing?.enabled ? 'ON' : 'OFF'} (${config.features?.briefing?.hourKST ?? 9}시 KST)`);
    } catch (e) { log.debug('Morning briefing init failed', { error: e.message }); }

    // 5.4. Feature #5 v5.0: A2A (Agent-to-Agent) Protocol 초기화
    let a2aEnabled = false;
    try {
      if (config.a2a?.enabled) {
        const { runAgent: runAgentFn } = require('./agents/runtime');
        const { A2ATaskManager } = require('./a2a/task-manager');
        const { router: a2aRouter, initializeRouter: initA2ARouter } = require('./a2a/router');

        // A2A Task Manager 생성
        const a2aTaskManager = new A2ATaskManager(runAgentFn, { episodic, semantic, entity });

        // A2A Router 초기화
        const defaultAgent = (config.agents?.list || []).find(a => a.default);
        const a2aAgentConfig = defaultAgent || {};
        initA2ARouter({
          config,
          taskManager: a2aTaskManager,
          agentRuntime: runAgentFn,
          agentConfig: a2aAgentConfig,
        });

        // Teams Express 서버에 A2A 마운트 (A2A는 독립 프로토콜이므로 주 포트에 마운트)
        // 또는 별도 포트로 노출 가능
        const teamsAdapter = gateway.adapters.get('teams');
        const basePath = process.env.BASE_PATH || '';
        if (teamsAdapter?.server) {
          teamsAdapter.server.use(a2aRouter);
          a2aEnabled = true;
        } else {
          // 폴백: 별도 미니 Express 앱 생성 (선택)
          a2aEnabled = true;
        }

        log.info('A2A (Agent-to-Agent) Protocol initialized', {
          enabled: true,
          publicUrl: config.a2a?.publicUrl || config.dashboard?.externalUrl || 'http://localhost:3000',
          apiKeys: config.a2a?.apiKeys?.length || 0,
        });
      }
    } catch (a2aErr) {
      log.warn('A2A initialization failed (non-critical)', { error: a2aErr.message });
    }

    // 6. 상태 출력 (LO-3: 배너는 포맷팅 목적으로 console.log 의도적 사용)
    const agents = config.agents?.list || [];
    const pools = Object.keys(config.memory?.pools || {});
    const bindings = config.bindings?.length || 0;

    console.log('');
    console.log('═════════════════════════════════════════════════════');
    console.log('  Effy v3.5+v4 — Native Gateway (async/await)');
    console.log('  Multi-Agent Architecture + Production Hardening');
    console.log('═════════════════════════════════════════════════════');
    console.log(`  Agents:       ${agents.map(a => `${a.id}${a.default ? '*' : ''}`).join(', ')}`);
    console.log(`  Pools:        ${pools.join(', ')}`);
    console.log(`  Bindings:     ${bindings} rules`);
    console.log(`  Budget:       LIGHT(8K) / STANDARD(35K) / DEEP(70K)`);
    console.log(`  DB:           PostgreSQL`);
    console.log(`  Channels:     ${[...gateway.adapters.keys()].join(', ') || 'none'}`);
    console.log('  ─── v3.5 Modules ───');
    console.log(`  ModelRouter:  ${config.modelRouter?.enabled !== false ? 'ON' : 'OFF'}`);
    console.log(`  CircuitBreak: ${config.circuitBreaker?.enabled !== false ? 'ON' : 'OFF'}`);
    console.log(`  Coalescer:    ${config.coalescer?.enabled !== false ? 'ON' : 'OFF'} (${config.coalescer?.debounceMs || 150}ms)`);
    console.log(`  BudgetGate:   $${config.cost?.monthlyBudgetUsd || 200}/mo`);
    console.log(`  Bulletin:     ${config.bulletin?.enabled !== false ? 'ON' : 'OFF'} (TTL ${config.bulletin?.ttlMs || 3600000}ms)`);
    console.log('  ─── v4 Port Modules ───');
    console.log(`  MemoryGraph:  ON (8 types, 5 edge types)`);
    console.log(`  MemorySearch: ON (FTS5 + importance re-ranking)`);
    console.log(`  Compaction:   ON (threshold ${config.compaction?.threshold || 0.8}, keep ${config.compaction?.keepRecentTurns || 10} turns)`);
    console.log(`  Logger:       Structured (LOG_LEVEL=${process.env.LOG_LEVEL || 'info'})`);
    console.log(`  ToolExecutor: Enhanced (DB tasks/incidents, graph knowledge)`);
    console.log(`  DataSource:   ${datasources.length > 0 ? `${datasources.length} connector(s)` : 'none configured'}`);
    console.log(`  Skills:       ${skillRegistry.installed.size > 0 ? `${skillRegistry.installed.size} installed` : 'none pre-installed (on-demand)'}`);
    console.log('  ─── v3.6 Self-Improvement ───');
    console.log(`  Reflection:   ON (correction detect + lesson promote)`);
    console.log(`  Outcome:      ON (sentiment + correction tracking)`);
    console.log(`  Distiller:    ${reflectionConfig.nightly?.enabled !== false ? 'ON' : 'OFF'} (nightly L2→L3 promotion)`);
    const committeeMembers = reflectionConfig.committee?.members || ['general', 'code', 'ops'];
    const humanCount = humanMembers.length;
    console.log(`  Committee:    ${reflectionConfig.committee?.enabled !== false ? 'ON' : 'OFF'} (AI:${committeeMembers.join(',')}${humanCount > 0 ? ` + Human:${humanCount}(×${humanMembers[0]?.weight ?? 2})` : ''} → ${reflectionConfig.committee?.votingOptions?.join('/') || 'approve/reject/defer'})`);
    console.log('  ─── v4.0 Ambient Intelligence ───');
    const obsConfig = config.observer || {};
    console.log(`  Observer:     ${obsConfig.enabled !== false ? 'ON' : 'OFF'} (channels=${(obsConfig.channels || ['*']).join(',')}, level=${obsConfig.proactive?.defaultLevel || 1})`);
    console.log(`  ChangeCtrl:   CRITICAL/HIGH → Admin approval required`);
    console.log('  ─── v5.0 Agent-to-Agent ───');
    console.log(`  A2A Protocol: ${a2aEnabled ? 'ON' : 'OFF'} (API keys: ${config.a2a?.apiKeys?.length || 0})`);
    // Dashboard URL: externalUrl 우선, 없으면 LAN IP 자동 감지
    const dashPort = config.github?.webhookPort || config.gateway?.port || 3100;
    const dashExtUrl = config.dashboard?.externalUrl;
    const { getLanIp } = require('./shared/utils');
    const dashDisplayUrl = dashExtUrl
      ? `${dashExtUrl.replace(/\/+$/, '')}/dashboard`
      : `http://${getLanIp()}:${dashPort}/dashboard`;
    console.log(`  Dashboard:    ${dashDisplayUrl}`);
    console.log('═════════════════════════════════════════════════════');
    console.log('');

    // PV-4 + PV-10: Daily data retention purge (episodic: 90d, audit: 365d, cost: 180d)
    const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const runPurge = async () => {
      try {
        const adapter = require('./db').getAdapter();
        if (typeof adapter.purgeEpisodicMemory === 'function') {
          await adapter.purgeEpisodicMemory(90);
        }
        if (typeof adapter.purgeAuditLog === 'function') {
          await adapter.purgeAuditLog(365);
        }
        if (typeof adapter.purgeCostLog === 'function') {
          await adapter.purgeCostLog(180);
        }
      } catch (purgeErr) {
        log.warn('Daily purge failed (non-critical)', { error: purgeErr.message });
      }
    };
    // Run once on startup (async, non-blocking), then daily
    runPurge();
    purgeTimer_ref = setInterval(runPurge, PURGE_INTERVAL_MS);
    purgeTimer_ref.unref();

  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
})();

// SF-3: Graceful shutdown
async function gracefulShutdown(signal) {
  log.info(`${signal} received, shutting down...`);

  if (gateway_ref) {
    const active = gateway_ref.governor.globalCount;
    if (active > 0) {
      log.info(`Waiting for ${active} in-flight requests (max ${SHUTDOWN_TIMEOUT_MS / 1000}s)...`);
      const start = Date.now();
      while (gateway_ref.governor.globalCount > 0 && (Date.now() - start) < SHUTDOWN_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 500));
      }
      const remaining = gateway_ref.governor.globalCount;
      if (remaining > 0) {
        log.warn(`Force closing with ${remaining} active requests`);
      }
    }

    // ─── v4.0: Session Recovery (serialize all active sessions) ───
    // CE-7: Add 10s timeout to prevent shutdown hang
    try {
      const SERIALIZE_TIMEOUT_MS = 10_000;
      const serialized = await Promise.race([
        gateway_ref.sessionRecovery.serializeAll(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Session serialization timed out')), SERIALIZE_TIMEOUT_MS)
        ),
      ]);
      if (serialized > 0) {
        log.info(`Session serialization: ${serialized} session(s) saved`);
      }
    } catch (serErr) {
      log.warn('Session serialization error', { error: serErr.message });
    }
  }

  // v3.5: 코얼레서 대기 메시지 즉시 처리
  if (gateway_ref?.coalescer) {
    gateway_ref.coalescer.flushAll();
    log.info('Coalescer flushed');
  }

  // P-6: RunLogger 스트림 플러시
  if (gateway_ref?.runLogger) {
    gateway_ref.runLogger.close();
  }

  // DataSource 커넥터 정리
  try {
    const dsReg = getRegistry();
    await dsReg.destroy();
  } catch (_) { /* best-effort */ }

  // Skill Registry 정리
  try {
    const { resetSkillRegistry } = require('./skills/registry');
    resetSkillRegistry();
  } catch (_) { /* best-effort */ }

  // v3.6: Reflection 정리
  try {
    destroyReflection();
  } catch (_) { /* best-effort */ }

  // OP-1: Clear health check and purge timer
  if (purgeTimer_ref) {
    clearInterval(purgeTimer_ref);
  }

  await db.close();
  log.info('DB closed. Bye.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
