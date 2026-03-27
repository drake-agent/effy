const { createLogger } = require('../../shared/logger');
const log = createLogger('core:autonomy');

/**
 * 자율 루프 (자아-지향 인식)
 * Autonomy Loop — Self-Directed Cognition
 *
 * 코텍스 프로세스로서 자율적 주도 작업을 수행.
 * 일정 간격으로 깨어나 아이덴티티 컨텍스트 + 메모리 불릿틴 + 활성 태스크를 사용하여
 * 무엇을 조사할지 결정하고, 실제 작업을 위해 워커를 스폰.
 */
class AutonomyLoop {
  /**
   * @param {Object} opts - 설정 옵션
   * @param {boolean} [opts.enabled=false] - 기본 비활성화 (명시적 활성화 필요)
   * @param {number} [opts.intervalMs=1800000] - 30분 기본 (밀리초)
   * @param {number} [opts.maxTurns=5] - 자율 세션당 최대 LLM 턴
   * @param {number} [opts.maxWorkers=2] - 동시 스폰 워커 수
   * @param {boolean} [opts.tasksRequireApproval=true] - 태스크 생성 시 승인 필요 여부
   * @param {Function} [opts.getIdentity] - async (agentId) => { soul, identity, role }
   * @param {Function} [opts.getBulletin] - async (agentId) => string
   * @param {Function} [opts.getActiveTasks] - async (agentId) => Array<Object>
   * @param {Function} [opts.getRecentEvents] - async (agentId) => Array<Object>
   * @param {Function} [opts.spawnWorker] - async (task) => result
   * @param {Function} [opts.saveMemory] - async (memory) => void
   * @param {Function} [opts.callLLM] - async (messages) => { content: string }
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled ?? false;
    this.intervalMs = opts.intervalMs ?? 1800000; // 30분
    this.maxTurns = opts.maxTurns ?? 5;
    this.maxWorkers = opts.maxWorkers ?? 2;
    this.tasksRequireApproval = opts.tasksRequireApproval ?? true;

    // 콜백 함수
    this.getIdentity = opts.getIdentity ?? this._defaultGetIdentity;
    this.getBulletin = opts.getBulletin ?? this._defaultGetBulletin;
    this.getActiveTasks = opts.getActiveTasks ?? this._defaultGetActiveTasks;
    this.getRecentEvents = opts.getRecentEvents ?? this._defaultGetRecentEvents;
    this.spawnWorker = opts.spawnWorker ?? this._defaultSpawnWorker;
    this.saveMemory = opts.saveMemory ?? this._defaultSaveMemory;
    this.callLLM = opts.callLLM ?? this._defaultCallLLM;

    this._timerId = null;
    this._isRunning = false;
    this._activeAgentId = null;
  }

  /**
   * 자율 루프 시작
   * @param {string} agentId - 에이전트 ID
   */
  start(agentId) {
    if (!this.enabled) {
      log.warn('autonomy-loop disabled, skipping start', { agentId });
      return;
    }

    if (this._isRunning) {
      log.warn('autonomy-loop already running', { agentId });
      return;
    }

    this._activeAgentId = agentId;
    this._isRunning = true;
    log.info('autonomy-loop starting', { agentId, intervalMs: this.intervalMs });

    this._schedule();
  }

  /**
   * 루프 중지
   */
  stop() {
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
    this._isRunning = false;
    log.info('autonomy-loop stopped');
  }

  /**
   * 단일 자율 사이클 실행 (수동 트리거 가능)
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<{ actions: Array, memoriesSaved: number, workersSpawned: number }>}
   */
  async runCycle(agentId) {
    log.info('autonomy-cycle starting', { agentId });

    try {
      // 컨텍스트 조립
      const context = await this._assembleContext(agentId);
      log.debug('context assembled', { agentId, contextKeys: Object.keys(context) });

      // LLM에서 의사결정
      const decision = await this._decide(context, agentId);
      log.debug('decision made', { agentId, actionCount: decision.actions.length });

      // 액션 실행
      const result = await this._executeActions(agentId, decision.actions);

      log.info('autonomy-cycle completed', {
        agentId,
        observations: decision.observations.length,
        actions: decision.actions.length,
        workersSpawned: result.workersSpawned,
        memoriesSaved: result.memoriesSaved,
      });

      return result;
    } catch (err) {
      log.error('autonomy-cycle failed', err);
      return { actions: [], memoriesSaved: 0, workersSpawned: 0 };
    }
  }

  /**
   * 컨텍스트 조립 (아이덴티티 + 불릿틴 + 태스크 + 이벤트)
   * @private
   * @param {string} agentId
   * @returns {Promise<Object>}
   */
  async _assembleContext(agentId) {
    const [identity, bulletin, activeTasks, recentEvents] = await Promise.all([
      this.getIdentity(agentId).catch(() => ({ soul: '', identity: '', role: '' })),
      this.getBulletin(agentId).catch(() => ''),
      this.getActiveTasks(agentId).catch(() => []),
      this.getRecentEvents(agentId).catch(() => []),
    ]);

    const identityStr = `## 영혼 (Soul)\n${identity.soul}\n\n## 아이덴티티 (Identity)\n${identity.identity}\n\n## 역할 (Role)\n${identity.role}`;
    const taskStr =
      activeTasks.length > 0
        ? activeTasks.map((t, i) => `${i + 1}. [${t.status}] ${t.name}`).join('\n')
        : '활성 태스크 없음';
    const eventStr =
      recentEvents.length > 0
        ? recentEvents.slice(0, 20).map((e) => `- ${e.timestamp}: ${e.message}`).join('\n')
        : '최근 이벤트 없음';

    return {
      agentId,
      identity: identityStr,
      bulletin,
      activeTasks: taskStr,
      recentEvents: eventStr,
    };
  }

  /**
   * LLM에 자율 판단 요청
   * @private
   * @param {Object} context - 조립된 컨텍스트
   * @param {string} agentId
   * @returns {Promise<{ observations: Array<string>, actions: Array<Object> }>}
   */
  async _decide(context, agentId) {
    const systemPrompt = `당신은 에이전트 ${agentId}의 자율 루프 모듈입니다.

## 당신의 아이덴티티
${context.identity}

## 현재 상황
${context.bulletin}

## 활성 태스크
${context.activeTasks}

## 최근 이벤트
${context.recentEvents}

당신의 아이덴티티와 현재 상황을 바탕으로 선제적으로 취할 조치를 결정하세요.
다음 형식의 JSON을 반환하세요: { "observations": ["..."], "actions": [{ "type": "spawn_worker"|"save_memory"|"create_task"|"log_observation", "params": {...} }] }
주의할 사항이 없으면 { "observations": ["모든 것이 조용함"], "actions": [] }을 반환하세요.`;

    const messages = [{ role: 'user', content: systemPrompt }];

    try {
      const response = await this.callLLM(messages);
      const text = response.content || response;
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        log.warn('no json found in llm response', { agentId, responsePreview: text.substring(0, 100) });
        return { observations: [], actions: [] };
      }

      const decision = JSON.parse(jsonMatch[0]);
      return {
        observations: decision.observations || [],
        actions: decision.actions || [],
      };
    } catch (err) {
      log.error('llm decision failed', err);
      return { observations: [], actions: [] };
    }
  }

  /**
   * 결정된 액션 실행
   * @private
   * @param {string} agentId
   * @param {Array<Object>} actions
   * @returns {Promise<{ workersSpawned: number, memoriesSaved: number }>}
   */
  async _executeActions(agentId, actions) {
    let workersSpawned = 0;
    let memoriesSaved = 0;

    // 워커 스폰 횟수 제한
    const spawns = actions.filter((a) => a.type === 'spawn_worker').slice(0, this.maxWorkers);

    for (const action of actions) {
      try {
        if (action.type === 'spawn_worker') {
          const task = action.params;
          log.info('spawning worker', { agentId, taskName: task.name });
          await this.spawnWorker(task);
          workersSpawned++;
        } else if (action.type === 'save_memory') {
          const memory = action.params;
          log.info('saving memory', { agentId, memoryType: memory.type });
          await this.saveMemory(memory);
          memoriesSaved++;
        } else if (action.type === 'create_task') {
          const task = action.params;
          log.info('task creation requested', {
            agentId,
            taskName: task.name,
            requiresApproval: this.tasksRequireApproval,
          });
          // 실제 생성은 승인 워크플로우에서 처리
        } else if (action.type === 'log_observation') {
          const obs = action.params;
          log.info('autonomy observation', { agentId, observation: obs.message });
        }
      } catch (err) {
        log.error('action execution failed', err);
      }
    }

    return { workersSpawned, memoriesSaved };
  }

  /**
   * 루프 일정 설정
   * @private
   */
  _schedule() {
    if (!this._isRunning || !this._activeAgentId) return;

    this._timerId = setTimeout(async () => {
      try {
        await this.runCycle(this._activeAgentId);
      } catch (err) {
        log.error('scheduled cycle failed', err);
      }
      this._schedule();
    }, this.intervalMs);
  }

  /**
   * 루프 상태 조회
   * @returns {Object}
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isRunning: this._isRunning,
      activeAgentId: this._activeAgentId,
      intervalMs: this.intervalMs,
      maxTurns: this.maxTurns,
      maxWorkers: this.maxWorkers,
    };
  }

  // ============= 기본 구현 (오버라이드 가능) =============

  /**
   * @private
   */
  async _defaultGetIdentity(agentId) {
    return { soul: '', identity: '', role: '' };
  }

  /**
   * @private
   */
  async _defaultGetBulletin(agentId) {
    return '';
  }

  /**
   * @private
   */
  async _defaultGetActiveTasks(agentId) {
    return [];
  }

  /**
   * @private
   */
  async _defaultGetRecentEvents(agentId) {
    return [];
  }

  /**
   * @private
   */
  async _defaultSpawnWorker(task) {
    log.debug('mock worker spawned', { taskName: task.name });
    return { success: true };
  }

  /**
   * @private
   */
  async _defaultSaveMemory(memory) {
    log.debug('mock memory saved', { type: memory.type });
  }

  /**
   * @private
   */
  async _defaultCallLLM(messages) {
    return { content: '{ "observations": [], "actions": [] }' };
  }
}

module.exports = { AutonomyLoop };
