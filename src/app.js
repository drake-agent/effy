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
const sqlite = require('./db/sqlite');
const { Gateway } = require('./gateway/gateway');
const { SlackAdapter } = require('./gateway/adapters/slack');
const { startWebhookServer } = require('./github/webhook');
const { setBulletin } = require('./memory/indexer');
const { getRegistry } = require('./datasource/registry');
const { getSkillRegistry } = require('./skills/registry');
const { initReflection, getCommittee, destroyReflection } = require('./reflection');
const { createLogger } = require('./shared/logger');

const log = createLogger('boot');

// SF-3: Graceful shutdown에서 참조 (TDZ 방지: IIFE보다 먼저 선언)
let gateway_ref = null;
const SHUTDOWN_TIMEOUT_MS = 15000;

// ─── 부팅 ───
(async () => {
  try {
    // 1. 설정 검증
    validate();

    // 2. DB 초기화 + v3.5/v4 마이그레이션
    sqlite.init(config.db.sqlitePath);
    sqlite.migrate();
    log.info(`DB initialized: ${config.db.sqlitePath}`);

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

    // 3. Gateway 생성
    const gateway = new Gateway();
    gateway_ref = gateway;

    // v3.5: Indexer에 Bulletin 인스턴스 주입
    if (gateway.bulletin) {
      setBulletin(gateway.bulletin);
    }
    log.info('Gateway created (v3.5+v4 modules active)');

    // 3.1. v4.0: Organization 구조 로드 → Entity Memory
    try {
      const { loadOrganization } = require('./organization/loader');
      const orgStats = loadOrganization();
      if (orgStats.memberCount > 0) {
        log.info(`Organization loaded: ${orgStats.deptCount} depts, ${orgStats.memberCount} members, ${orgStats.projectCount} projects`);
      }
    } catch { /* org config optional */ }

    // 4. Slack 어댑터
    let slackAdapter = null;
    if (config.channels?.slack?.enabled !== false) {
      slackAdapter = new SlackAdapter(config.channels.slack, gateway);
      gateway.registerAdapter('slack', slackAdapter);
      await slackAdapter.start();
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

    log.info(`Reflection initialized (nightly=${reflectionConfig.nightly?.enabled !== false ? 'ON' : 'OFF'}, committee=${reflectionConfig.committee?.enabled !== false ? 'ON' : 'OFF'}${humanMembers.length > 0 ? `, hybrid=ON(${humanMembers.length} humans)` : ''})`);

    // 5. GitHub Webhook + Dashboard
    if (config.github?.enabled && config.github?.webhookSecret) {
      const slackAdapterForWebhook = gateway.adapters.get('slack');
      startWebhookServer(slackAdapterForWebhook?.client || null);
      log.info(`GitHub webhook on :${config.gateway?.port || 3100}`);
    }

    // 5.1. Dashboard — Gateway/RunLogger 주입
    try {
      const { injectDashboard } = require('./dashboard/router');
      injectDashboard(gateway, gateway.runLogger);
      log.info('Dashboard: Gateway/RunLogger injected');
    } catch { /* dashboard optional */ }

    // 5.2. v4.0: Observer (Ambient Intelligence) 초기화
    try {
      const { getObserver } = require('./observer');
      const observer = getObserver();
      const slackAdapterInstance = gateway.adapters.get('slack');
      observer.init({
        config: config.observer || {},
        episodic,
        semantic,
        graph: gateway.memoryGraph,
        slackClient: slackAdapterInstance?.client || null,
      });
      log.info(`Observer: ${config.observer?.enabled !== false ? 'ON' : 'OFF'} (channels=${(config.observer?.channels || ['*']).join(',')})`);
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
    } catch { /* briefing optional */ }

    // 6. 상태 출력 (LO-3: 배너는 포맷팅 목적으로 console.log 의도적 사용)
    const agents = config.agents?.list || [];
    const pools = Object.keys(config.memory?.pools || {});
    const bindings = config.bindings?.length || 0;

    console.log('');
    console.log('═════════════════════════════════════════════════════');
    console.log('  Effy v3.5+v4 — Native Gateway (async/await)');
    console.log('  Spacebot Architecture + Production Hardening');
    console.log('═════════════════════════════════════════════════════');
    console.log(`  Agents:       ${agents.map(a => `${a.id}${a.default ? '*' : ''}`).join(', ')}`);
    console.log(`  Pools:        ${pools.join(', ')}`);
    console.log(`  Bindings:     ${bindings} rules`);
    console.log(`  Budget:       LIGHT(8K) / STANDARD(35K) / DEEP(70K)`);
    console.log(`  DB:           Phase ${config.db.phase} (${config.db.isSQLite ? 'SQLite' : 'PostgreSQL'})`);
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

  sqlite.close();
  log.info('DB closed. Bye.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
