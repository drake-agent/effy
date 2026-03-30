#!/usr/bin/env node

/**
 * verify.js — Phase 2 분산 아키텍처 모듈 검증.
 *
 * 모든 모듈이 정상적으로 로드되고 내보내는지 확인.
 */

const path = require('path');
const { createLogger } = require('../shared/logger');

const log = createLogger('verify');

// 색상 코드
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function verify() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Phase 2 Distributed Architecture Verification');
  console.log('═══════════════════════════════════════════════════════\n');

  const checks = [];
  let passed = 0;
  let failed = 0;

  // 1. 모듈 로드
  console.log('1. Loading modules...');

  try {
    const dist = require('./index');
    const exports = [
      'DistributedArchitecture',
      'AgentService',
      'LocalMessageBus',
      'RedisMessageBus',
      'createMessageBus',
      'LocalSessionStore',
      'RedisSessionStore',
      'createSessionStore',
      'StaticServiceDiscovery',
      'KubernetesServiceDiscovery',
      'createServiceDiscovery',
      'CircuitBreaker',
      'getDistributedArchitecture',
      'initDistributedArchitecture',
      'resetDistributedArchitecture',
    ];

    for (const name of exports) {
      if (dist[name]) {
        console.log(`   ${GREEN}✓${RESET} ${name}`);
        passed++;
      } else {
        console.log(`   ${RED}✗${RESET} ${name} (not exported)`);
        failed++;
      }
    }
  } catch (err) {
    console.log(`   ${RED}✗${RESET} Failed to load index.js: ${err.message}`);
    failed++;
  }

  // 2. 개별 모듈 검증
  console.log('\n2. Checking individual modules...');

  const modules = [
    { name: 'agent-service.js', exports: ['AgentService'] },
    { name: 'message-bus.js', exports: ['LocalMessageBus', 'RedisMessageBus', 'createMessageBus'] },
    { name: 'session-store.js', exports: ['LocalSessionStore', 'RedisSessionStore', 'createSessionStore'] },
    { name: 'discovery.js', exports: ['StaticServiceDiscovery', 'KubernetesServiceDiscovery', 'createServiceDiscovery', 'CircuitBreaker'] },
  ];

  for (const mod of modules) {
    try {
      const m = require(`./${mod.name}`);
      console.log(`   ${GREEN}✓${RESET} ${mod.name}`);
      for (const exp of mod.exports) {
        if (m[exp]) {
          console.log(`      → ${exp}`);
        } else {
          console.log(`      ${RED}✗${RESET} ${exp} missing`);
          failed++;
        }
      }
      passed++;
    } catch (err) {
      console.log(`   ${RED}✗${RESET} ${mod.name}: ${err.message}`);
      failed++;
    }
  }

  // 3. LocalMessageBus 동작 테스트
  console.log('\n3. Testing LocalMessageBus...');

  try {
    const { LocalMessageBus } = require('./message-bus');
    const bus = new LocalMessageBus();

    let testPassed = false;
    bus.register('test-agent', async (msg) => {
      if (msg.type === 'ping') {
        testPassed = true;
        return { status: 'pong' };
      }
    });

    const response = await bus.request('main', 'test-agent', 'ping', {});
    if (testPassed && response.status === 'pong') {
      console.log(`   ${GREEN}✓${RESET} Request-reply pattern works`);
      passed++;
    } else {
      console.log(`   ${RED}✗${RESET} Request-reply pattern failed`);
      failed++;
    }
  } catch (err) {
    console.log(`   ${RED}✗${RESET} LocalMessageBus test failed: ${err.message}`);
    failed++;
  }

  // 4. LocalSessionStore 동작 테스트
  console.log('\n4. Testing LocalSessionStore...');

  try {
    const { LocalSessionStore } = require('./session-store');
    const store = new LocalSessionStore();

    await store.set('session-1', { userId: 'user@example.com' }, 3600000);
    const session = await store.get('session-1');

    if (session && session.userId === 'user@example.com') {
      console.log(`   ${GREEN}✓${RESET} Session storage works`);
      passed++;
    } else {
      console.log(`   ${RED}✗${RESET} Session storage failed`);
      failed++;
    }

    await store.close();
  } catch (err) {
    console.log(`   ${RED}✗${RESET} LocalSessionStore test failed: ${err.message}`);
    failed++;
  }

  // 5. StaticServiceDiscovery 동작 테스트
  console.log('\n5. Testing StaticServiceDiscovery...');

  try {
    const { StaticServiceDiscovery } = require('./discovery');
    const discovery = new StaticServiceDiscovery({
      agents: {
        general: { host: 'localhost', port: 3101, replicas: 1 },
        code: { host: 'localhost', port: 3102, replicas: 1 },
      },
    });

    const general = discovery.resolveAgent('general');
    const code = discovery.resolveAgent('code');

    if (general && general.port === 3101 && code && code.port === 3102) {
      console.log(`   ${GREEN}✓${RESET} Service discovery works`);
      passed++;
    } else {
      console.log(`   ${RED}✗${RESET} Service discovery failed`);
      failed++;
    }

    await discovery.close();
  } catch (err) {
    console.log(`   ${RED}✗${RESET} StaticServiceDiscovery test failed: ${err.message}`);
    failed++;
  }

  // 6. DistributedArchitecture 싱글톤 테스트
  console.log('\n6. Testing DistributedArchitecture singleton...');

  try {
    const { getDistributedArchitecture, resetDistributedArchitecture } = require('./index');
    const dist1 = getDistributedArchitecture({ enabled: false });
    const dist2 = getDistributedArchitecture({ enabled: false });

    if (dist1 === dist2) {
      console.log(`   ${GREEN}✓${RESET} Singleton pattern works`);
      passed++;
    } else {
      console.log(`   ${RED}✗${RESET} Singleton pattern failed`);
      failed++;
    }

    resetDistributedArchitecture();
  } catch (err) {
    console.log(`   ${RED}✗${RESET} Singleton test failed: ${err.message}`);
    failed++;
  }

  // 7. 파일 존재 확인
  console.log('\n7. Checking file existence...');

  const fs = require('fs');
  const files = [
    'agent-service.js',
    'message-bus.js',
    'session-store.js',
    'discovery.js',
    'index.js',
    'README.md',
    'INTEGRATION.md',
    'verify.js',
  ];

  for (const file of files) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`   ${GREEN}✓${RESET} ${file} (${stats.size} bytes)`);
      passed++;
    } else {
      console.log(`   ${RED}✗${RESET} ${file} not found`);
      failed++;
    }
  }

  // 요약
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log(`${GREEN}All checks passed!${RESET}\n`);
    console.log('Next steps:');
    console.log('  1. Review effy.config.yaml distributed section');
    console.log('  2. Read /src/distributed/README.md');
    console.log('  3. Follow /src/distributed/INTEGRATION.md for your use case\n');
    process.exit(0);
  } else {
    console.log(`${RED}Some checks failed. Please review the errors above.${RESET}\n`);
    process.exit(1);
  }
}

verify().catch((err) => {
  log.error(`Verification failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
