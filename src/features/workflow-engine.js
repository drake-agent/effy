/**
 * workflow-engine.js — 작업 체인 자동 실행.
 *
 * 단일 트리거로 여러 도구를 순차/병렬 실행하는 워크플로우 엔진.
 *
 * 예:
 * "신규 입사자 온보딩" 워크플로우:
 *   1. create_task "온보딩 체크리스트" → assignee
 *   2. send_message #general "새 팀원 환영"
 *   3. send_agent_message knowledge "온보딩 문서 준비"
 *
 * "인시던트 대응" 워크플로우:
 *   1. create_incident sev1
 *   2. send_message #ops "인시던트 발생"
 *   3. shell "git log --oneline -5"
 *
 * 워크플로우 정의: config.workflows 또는 /effy workflow 슬래시 커맨드
 * 실행: "@effy 인시던트 대응 실행" 또는 Observer insight 트리거
 */
const { config } = require('../config');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:workflow');

class WorkflowEngine {
  constructor(opts = {}) {
    this.executeTool = opts.executeTool || null;  // runtime.js의 executeTool 함수
    this.slackClient = opts.slackClient || null;

    // 등록된 워크플로우
    this.workflows = new Map();

    // 실행 이력
    this.history = [];

    // Config에서 워크플로우 로드
    this._loadFromConfig();
  }

  /**
   * 워크플로우 등록.
   *
   * @param {string} id - 워크플로우 ID
   * @param {object} def - { name, description, trigger, steps: [...] }
   */
  register(id, def) {
    this.workflows.set(id, {
      id,
      name: def.name || id,
      description: def.description || '',
      trigger: def.trigger || null,  // 자동 트리거 조건 (keyword, event 등)
      steps: def.steps || [],
      createdAt: Date.now(),
    });
    log.info('Workflow registered', { id, steps: def.steps?.length || 0 });
  }

  /**
   * 워크플로우 실행.
   *
   * @param {string} workflowId
   * @param {object} ctx - { userId, channelId, variables }
   * @returns {object} 실행 결과
   */
  async execute(workflowId, ctx = {}) {
    const wf = this.workflows.get(workflowId);
    if (!wf) return { success: false, error: `워크플로우 '${workflowId}' 없음` };

    const run = {
      workflowId,
      startedAt: Date.now(),
      steps: [],
      status: 'running',
      variables: { ...ctx.variables },
    };

    log.info('Workflow started', { id: workflowId, name: wf.name });

    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      const stepResult = { index: i, tool: step.tool, status: 'pending' };

      try {
        // 변수 치환: ${variable} → 실제 값
        const input = this._resolveVariables(step.input || {}, run.variables);

        if (this.executeTool) {
          const result = await this.executeTool(step.tool, input, {
            messageContext: { userId: ctx.userId, channelId: ctx.channelId, agentId: 'ops' },
            slackClient: this.slackClient,
            accessiblePools: ['team'],
            writablePools: ['team'],
            toolNames: [],
          });

          stepResult.result = result;
          stepResult.status = result.error ? 'failed' : 'success';

          // 결과를 변수에 저장 (다음 step에서 참조 가능)
          if (step.outputVar) {
            run.variables[step.outputVar] = result;
          }
        } else {
          stepResult.status = 'skipped';
          stepResult.reason = 'executeTool not available';
        }

        // step 실패 시 중단 (continueOnError가 아니면)
        // NEW-14 fix: 실패 시에도 아래 공통 push에서 처리 (중복 push 방지)
        if (stepResult.status === 'failed' && !step.continueOnError) {
          run.status = 'failed';
          run.failedAt = i;
          run.steps.push(stepResult);
          break;
        }
      } catch (err) {
        stepResult.status = 'error';
        stepResult.error = err.message;

        if (!step.continueOnError) {
          run.status = 'failed';
          run.failedAt = i;
          run.steps.push(stepResult);
          break;
        }
      }

      run.steps.push(stepResult);
    }

    if (run.status === 'running') run.status = 'completed';
    run.completedAt = Date.now();
    run.durationMs = run.completedAt - run.startedAt;

    this.history.push(run);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);

    log.info('Workflow completed', {
      id: workflowId, status: run.status,
      steps: run.steps.length, duration: run.durationMs,
    });

    return run;
  }

  /**
   * 트리거 키워드로 워크플로우 검색.
   *
   * @param {string} text - 사용자 메시지
   * @returns {object|null} 매칭된 워크플로우
   */
  findByTrigger(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    for (const wf of this.workflows.values()) {
      if (!wf.trigger) continue;

      // keyword 트리거
      if (wf.trigger.keywords) {
        for (const kw of wf.trigger.keywords) {
          if (lower.includes(kw.toLowerCase())) return wf;
        }
      }

      // regex 트리거
      if (wf.trigger.regex) {
        const re = new RegExp(wf.trigger.regex, 'i');
        if (re.test(text)) return wf;
      }
    }
    return null;
  }

  /**
   * 변수 치환: ${var} → 실제 값.
   */
  _resolveVariables(obj, variables) {
    if (typeof obj === 'string') {
      const wholeVar = obj.match(/^\$\{(\w+)\}$/);
      if (wholeVar) {
        return this._cloneValue(variables[wholeVar[1]] ?? '');
      }

      return obj.replace(/\$\{(\w+)\}/g, (_, name) => {
        const val = variables[name];
        if (val === undefined) return '';
        return typeof val === 'string' ? val : JSON.stringify(val);
      });
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this._resolveVariables(item, variables));
    }

    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, this._resolveVariables(value, variables)])
      );
    }

    return obj;
  }

  _cloneValue(value) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      return JSON.parse(JSON.stringify(value));
    }
    return value;
  }

  _loadFromConfig() {
    const workflows = config.workflows || [];
    for (const wf of workflows) {
      if (wf.id) this.register(wf.id, wf);
    }
  }

  /**
   * 등록된 워크플로우 목록.
   */
  list() {
    return [...this.workflows.values()].map(wf => ({
      id: wf.id, name: wf.name, description: wf.description,
      steps: wf.steps.length, trigger: wf.trigger,
    }));
  }

  getStats() {
    return {
      registered: this.workflows.size,
      history: this.history.length,
      recent: this.history.slice(-5).map(r => ({
        id: r.workflowId, status: r.status, duration: r.durationMs,
      })),
    };
  }
}

module.exports = { WorkflowEngine };
