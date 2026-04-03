/**
 * tool-registry.js — P-2: Tool Registry as Single Source of Truth.
 *
 * 모든 도구 정의를 한 곳에서 관리.
 * 파생 함수로 디스패치, 문서 생성, 검증, 에이전트별 접근 제어를 모두 처리.
 *
 * 도구 추가 시 이 파일만 수정하면 된다.
 */

// ─── 도구 정의 (Single Source of Truth) ───
const TOOL_DEFINITIONS = {
  slack_reply: {
    name: 'slack_reply',
    category: 'communication',
    description: 'Slack 채널/스레드에 메시지 전송',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        text: { type: 'string', description: 'Message text' },
        thread_ts: { type: 'string', description: 'Thread timestamp (optional)' },
      },
      required: ['channel', 'text'],
    },
  },

  search_knowledge: {
    name: 'search_knowledge',
    category: 'memory',
    description: '팀 지식베이스 검색. 크로스채널 결정사항, 기술 스펙, 정책 등 조회 가능.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드 또는 질문' },
        channel_filter: { type: 'string', description: '특정 채널로 필터링 (optional)' },
      },
      required: ['query'],
    },
  },

  save_knowledge: {
    name: 'save_knowledge',
    category: 'memory',
    description: '중요 정보(결정사항, 정책, 스펙)를 팀 지식베이스에 영구 저장.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '저장할 내용' },
        tags: { type: 'array', items: { type: 'string' }, description: '분류 태그' },
        source_type: { type: 'string', enum: ['decision', 'document', 'wiki', 'spec'] },
        pool_id: { type: 'string', description: '저장할 메모리 풀 (team/engineering/design)' },
      },
      required: ['content'],
    },
  },

  create_task: {
    name: 'create_task',
    category: 'ops',
    description: '팀원에게 작업 할당. Slack 메시지로 알림.',
    agents: ['ops'],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignee: { type: 'string', description: 'Slack user ID' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
      },
      required: ['title'],
    },
  },

  create_incident: {
    name: 'create_incident',
    category: 'ops',
    description: '인시던트 생성. 관련 채널에 자동 알림.',
    agents: ['ops'],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['sev1', 'sev2', 'sev3'] },
        description: { type: 'string' },
        affected_service: { type: 'string' },
      },
      required: ['title', 'severity'],
    },
  },

  // ─── DataSource Connector 도구 ───

  query_datasource: {
    name: 'query_datasource',
    category: 'datasource',
    description: '연결된 외부 데이터 소스(API, DB, 파일시스템)를 조회. connector_id로 대상 지정, query로 조회 내용 지정.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        connector_id: { type: 'string', description: '데이터 소스 ID (예: erp-api, analytics-db, shared-docs)' },
        query: { type: 'string', description: 'REST: API 경로, SQL: SELECT 쿼리, FileSystem: list/read/search 명령' },
        params: {
          type: 'object',
          description: 'REST: { method, body }, SQL: { bindings }, FS: { recursive }',
        },
      },
      required: ['connector_id', 'query'],
    },
  },

  list_datasources: {
    name: 'list_datasources',
    category: 'datasource',
    description: '사용 가능한 데이터 소스 목록 조회. 어떤 데이터 소스가 연결되어 있는지 확인할 때 사용.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ─── Skill 도구 ───

  search_skills: {
    name: 'search_skills',
    category: 'skills',
    description: '스킬 카탈로그 검색. 에이전트 능력을 확장할 스킬(docx, pdf, pptx, xlsx, security-analysis 등)을 키워드로 검색.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드 (예: "document", "security", "presentation")' },
        category: { type: 'string', description: '카테고리 필터 (document, coding, design, security, utility)' },
      },
      required: ['query'],
    },
  },

  install_skill: {
    name: 'install_skill',
    category: 'skills',
    description: '스킬 설치 (GitHub에서 다운로드). search_skills로 찾은 스킬 ID를 사용. ⚠️ Admin 전용.',
    agents: ['*'],
    adminOnly: true, // BL-3: require admin for skill installation
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '스킬 ID (예: "docx", "security-analysis")' },
      },
      required: ['skill_id'],
    },
  },

  list_skills: {
    name: 'list_skills',
    category: 'skills',
    description: '설치된 스킬 목록 조회. 활성/비활성 상태 포함.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  activate_skill: {
    name: 'activate_skill',
    category: 'skills',
    description: '설치된 스킬을 현재 에이전트에 활성화. 활성화된 스킬의 지시문이 시스템 프롬프트에 주입됨.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '활성화할 스킬 ID' },
      },
      required: ['skill_id'],
    },
  },

  create_skill: {
    name: 'create_skill',
    category: 'skills',
    description: [
      '대화형 스킬 빌더. 사용자 요청을 바탕으로 커스텀 스킬을 생성하고 즉시 등록한다.',
      '사용자가 "~스킬 만들어줘"라고 하면 이 도구를 호출한다.',
      '',
      '입력: skill_id, name, description, instructions (스킬 본문 지시문).',
      '동작: SKILL.md를 frontmatter + body 형식으로 조립 → registerLocal() → 즉시 활성화.',
      '',
      '예: "대시보드 요약 스킬 만들어줘" →',
      '  skill_id: "dashboard-summary"',
      '  name: "Dashboard Summary"',
      '  description: "팀 대시보드 데이터를 요약하는 스킬"',
      '  instructions: "## 역할\\n당신은 대시보드 데이터 분석가입니다..."',
    ].join('\n'),
    agents: ['*'],
    adminOnly: true, // LLM-1: skill creation requires admin
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '스킬 ID (kebab-case, 예: "dashboard-summary")' },
        name: { type: 'string', description: '스킬 표시 이름' },
        description: { type: 'string', description: '스킬 설명 (1-2문장)' },
        instructions: { type: 'string', description: '스킬 본문 지시문 (에이전트 system prompt에 주입될 내용). Markdown 형식. 최대 4000자.', maxLength: 4000 },
        category: { type: 'string', description: '카테고리 (document, coding, design, workflow, analysis, communication, custom)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '검색용 태그 배열',
        },
        activate_for: { type: 'string', description: '즉시 활성화할 에이전트 ID (기본: 호출한 에이전트)' },
      },
      required: ['skill_id', 'name', 'description', 'instructions'],
    },
  },

  delete_skill: {
    name: 'delete_skill',
    category: 'skills',
    description: '로컬에서 생성한 커스텀 스킬을 삭제한다. 카탈로그(GitHub) 스킬은 uninstall로 처리. ⚠️ Admin 전용.',
    agents: ['*'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '삭제할 스킬 ID' },
      },
      required: ['skill_id'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Communication — 확장 (크로스채널, 리액션, 파일)
  // ═══════════════════════════════════════════════════════

  send_message: {
    name: 'send_message',
    category: 'communication',
    description: '다른 채널에 메시지 전송. slack_reply는 원본 채널만 허용하지만, 이 도구는 지정 채널로 전송 가능. ops/admin 전용.',
    agents: ['ops'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '대상 채널 ID (C로 시작)' },
        text: { type: 'string', description: '메시지 내용' },
        thread_ts: { type: 'string', description: '스레드 타임스탬프 (optional)' },
      },
      required: ['channel', 'text'],
    },
  },

  react: {
    name: 'react',
    category: 'communication',
    description: '메시지에 이모지 리액션 추가. 처리 완료/확인/에러 등 비텍스트 피드백.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '채널 ID' },
        timestamp: { type: 'string', description: '리액션 대상 메시지 타임스탬프' },
        emoji: { type: 'string', description: '이모지 이름 (콜론 없이, 예: "white_check_mark", "eyes", "rotating_light")' },
      },
      required: ['channel', 'timestamp', 'emoji'],
    },
  },

  send_file: {
    name: 'send_file',
    category: 'communication',
    description: '채널에 텍스트 파일/스니펫 업로드. 코드, 로그, CSV 등 긴 텍스트를 파일로 공유.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '업로드 대상 채널 ID' },
        content: { type: 'string', description: '파일 내용 (텍스트)' },
        filename: { type: 'string', description: '파일 이름 (예: "report.csv", "debug.log")' },
        title: { type: 'string', description: '파일 제목 (Slack에 표시)' },
        filetype: { type: 'string', description: '파일 타입 (csv, json, python, javascript, text, markdown)' },
        thread_ts: { type: 'string', description: '스레드에 업로드 (optional)' },
      },
      required: ['channel', 'content', 'filename'],
    },
  },

  send_agent_message: {
    name: 'send_agent_message',
    category: 'communication',
    description: '다른 에이전트에게 내부 메시지 전송. 에이전트 간 협업 시 사용. 대상 에이전트가 메시지를 받아 처리.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        target_agent: { type: 'string', description: '대상 에이전트 ID (general, code, ops, knowledge, strategy)' },
        message: { type: 'string', description: '전달할 메시지/지시' },
        context: {
          type: 'object',
          description: '추가 컨텍스트 (optional)',
        },
      },
      required: ['target_agent', 'message'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Orchestration — v3.9 에이전트 협업 + 통합 검색
  // ═══════════════════════════════════════════════════════

  ask_agent: {
    name: 'ask_agent',
    category: 'communication',
    description: '다른 팀 에이전트에게 동기적으로 질문하고 즉시 답변을 받는다. send_agent_message와 달리 결과를 기다린다. 다른 팀의 정보가 필요할 때 사용.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        target_agent: { type: 'string', description: '대상 에이전트 ID (general, code, ops, knowledge, strategy)' },
        query: { type: 'string', description: '질문 내용 (구체적일수록 좋은 답변)' },
      },
      required: ['target_agent', 'query'],
    },
  },

  fetch_info: {
    name: 'fetch_info',
    category: 'memory',
    description: '통합 정보 검색. 메모리(대화 이력 + 저장된 지식) + 문서 + 팀 에이전트를 한 번에 검색. search_knowledge보다 넓은 범위. 정보가 어디 있는지 모를 때 사용.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 쿼리 (자연어)' },
        scope: {
          type: 'array',
          items: { type: 'string', enum: ['memory', 'knowledge', 'agents', 'entity'] },
          description: '검색 범위 (기본: memory + knowledge + agents)',
        },
        limit: { type: 'number', description: '최대 결과 수 (기본 10)' },
      },
      required: ['query'],
    },
  },

  list_team_agents: {
    name: 'list_team_agents',
    category: 'communication',
    description: '사용 가능한 팀 에이전트 목록과 각 에이전트의 전문 분야(capabilities) 조회. 누구에게 물어볼지 모를 때 먼저 호출.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // ═══════════════════════════════════════════════════════
  // Task — CRUD 완성
  // ═══════════════════════════════════════════════════════

  task_list: {
    name: 'task_list',
    category: 'ops',
    description: '태스크 목록 조회. 필터(상태, 담당자, 우선순위)로 검색.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'all'], description: '상태 필터 (기본: open)' },
        assignee: { type: 'string', description: '담당자 Slack User ID 필터 (optional)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: '우선순위 필터 (optional)' },
        limit: { type: 'number', description: '최대 개수 (기본 20)' },
      },
      required: [],
    },
  },

  task_update: {
    name: 'task_update',
    category: 'ops',
    description: '태스크 상태/담당자/우선순위 변경.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: '태스크 ID' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        assignee: { type: 'string', description: '새 담당자 Slack User ID' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        note: { type: 'string', description: '업데이트 사유/메모' },
      },
      required: ['task_id'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // System — 파일, 검색, 셸
  // ═══════════════════════════════════════════════════════

  file_read: {
    name: 'file_read',
    category: 'system',
    description: '허용된 디렉터리 내 파일 읽기. 로그, 설정 파일, 데이터 파일 분석용.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '파일 경로 (data/, logs/, config/ 하위만 허용)' },
        encoding: { type: 'string', description: '인코딩 (기본 utf-8)' },
        max_bytes: { type: 'number', description: '최대 읽기 바이트 (기본 100KB)' },
      },
      required: ['path'],
    },
  },

  file_write: {
    name: 'file_write',
    category: 'system',
    description: '허용된 디렉터리에 파일 쓰기. 리포트, 내보내기 데이터 생성용. ⚠️ Admin 전용.',
    agents: ['ops', 'code'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '파일 경로 (data/output/ 하위만 허용)' },
        content: { type: 'string', description: '파일 내용' },
        encoding: { type: 'string', description: '인코딩 (기본 utf-8)' },
      },
      required: ['path', 'content'],
    },
  },

  web_search: {
    name: 'web_search',
    category: 'system',
    description: '웹 검색. 최신 기술 문서, 에러 해결법, API 레퍼런스 조회.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 쿼리' },
        max_results: { type: 'number', description: '최대 결과 수 (기본 5)' },
      },
      required: ['query'],
    },
  },

  shell: {
    name: 'shell',
    category: 'system',
    description: '허용된 시스템 명령어 실행. git, npm, docker, curl 등 화이트리스트 명령만 허용. 위험 명령(rm -rf, sudo 등) 차단. ⚠️ Admin 전용.',
    agents: ['code', 'ops'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '실행할 명령어' },
        cwd: { type: 'string', description: '작업 디렉터리 (optional, 기본: 프로젝트 루트)' },
        timeout_ms: { type: 'number', description: '타임아웃 (기본 30000ms, 최대 120000ms)' },
      },
      required: ['command'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Config — 런타임 설정 조회
  // ═══════════════════════════════════════════════════════

  config_inspect: {
    name: 'config_inspect',
    category: 'config',
    description: '현재 런타임 설정 조회. 에이전트 구성, 메모리 풀, 데이터소스, 스킬 상태 등 확인. ⚠️ Admin 전용.',
    agents: ['*'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['agents', 'memory', 'datasources', 'skills', 'reflection', 'gateway', 'all'],
          description: '조회할 설정 섹션 (기본: all)',
        },
      },
      required: [],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Flow Control — 상태 관리
  // ═══════════════════════════════════════════════════════

  set_status: {
    name: 'set_status',
    category: 'flow',
    description: '에이전트 상태 메시지 설정. 사용자에게 현재 작업 상태를 알림 (예: "분석 중...", "배포 모니터링 중").',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        status_text: { type: 'string', description: '상태 메시지 (최대 100자)' },
        emoji: { type: 'string', description: '상태 이모지 (기본: speech_balloon)' },
        expiration_min: { type: 'number', description: '자동 해제 시간(분, 기본: 30)' },
      },
      required: ['status_text'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Memory — 확장
  // ═══════════════════════════════════════════════════════
  // memory_delete: 영구 비활성화 — 메모리 삭제는 허용하지 않음.
  // 오래된 데이터는 antiBloat(90일 아카이브)로 자동 관리.

  // ═══════════════════════════════════════════════════════
  // Integration — cron 예약 작업
  // ═══════════════════════════════════════════════════════

  cron_schedule: {
    name: 'cron_schedule',
    category: 'integration',
    description: '예약 작업 등록/조회/삭제. 주기적 리포트, 모니터링, 데이터 수집 자동화. ⚠️ Admin 전용.',
    agents: ['ops'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete'], description: '동작' },
        name: { type: 'string', description: '작업 이름 (create/delete 시 필수)' },
        cron_expr: { type: 'string', description: 'cron 표현식 (create 시 필수, 예: "0 9 * * 1-5")' },
        task_type: { type: 'string', description: '작업 유형 (create 시 필수, 예: "report", "monitor", "cleanup")' },
        task_config: { type: 'object', description: '작업 설정 (create 시, 유형별 상이)' },
      },
      required: ['action'],
    },
  },

  // ═══════════════════════════════════════════════════════
  // Context Hub — API 문서 검색/조회/소스 관리
  // ═══════════════════════════════════════════════════════

  search_api_docs: {
    name: 'search_api_docs',
    category: 'knowledge',
    description: 'API 공식 문서 검색. OpenAI, Stripe, Anthropic 등 602+ 패키지/프레임워크 문서. BM25 + keyword hybrid.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 키워드 (예: "openai streaming", "stripe payment intent")' },
        lang: { type: 'string', description: '언어 필터 (python, javascript, typescript, ruby, go 등)' },
        tags: { type: 'string', description: '태그 필터 (comma-separated, 예: "ai,llm")' },
        limit: { type: 'number', description: '결과 수 (기본 5, 최대 10)' },
      },
      required: ['query'],
    },
  },

  get_api_doc: {
    name: 'get_api_doc',
    category: 'knowledge',
    description: 'API 문서 전문 조회. search_api_docs 결과의 id로 호출. 코드 예제, 파라미터 상세 포함.',
    agents: ['code', 'knowledge'],
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '문서 ID (예: "openai/chat", "stripe/payment-intents")' },
        lang: { type: 'string', description: '언어 (기본: python)' },
        full: { type: 'boolean', description: '참조 파일 포함 여부 (기본: false)' },
      },
      required: ['id'],
    },
  },

  add_api_source: {
    name: 'add_api_source',
    category: 'knowledge',
    description: '커스텀 API 문서 소스 추가. 사내 API, 서드파티 API 등의 문서 레지스트리를 Effy에 연결. ⚠️ Admin 전용.',
    agents: ['ops', 'knowledge'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '소스 이름 (알파벳/숫자/하이픈, 예: "internal-api")' },
        url: { type: 'string', description: '소스 URL (registry.json이 있는 HTTPS 루트, 예: "https://docs.mycompany.com/v1")' },
        description: { type: 'string', description: '소스 설명 (선택)' },
      },
      required: ['name', 'url'],
    },
  },

  remove_api_source: {
    name: 'remove_api_source',
    category: 'knowledge',
    description: '커스텀 API 문서 소스 제거. add_api_source로 추가한 소스만 삭제 가능. ⚠️ Admin 전용.',
    agents: ['ops'],
    adminOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '삭제할 소스 이름' },
      },
      required: ['name'],
    },
  },

  list_api_sources: {
    name: 'list_api_sources',
    category: 'knowledge',
    description: '등록된 API 문서 소스 목록. 기본 소스(Context Hub)와 커스텀 소스 모두 표시.',
    agents: ['*'],
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
};

/**
 * functionType 기반으로 에이전트가 접근 가능한 도구 이름 목록 반환.
 *
 * agents 필드가 ['*']이면 모든 functionType에서 접근 가능.
 * 그 외에는 agents 배열에 functionType이 포함된 경우만 반환.
 *
 * @param {string} functionType - 'general' | 'code' | 'ops' | 'knowledge' | 'strategy'
 * @returns {string[]} 도구 이름 배열
 */
function getToolsForFunction(functionType) {
  return Object.keys(TOOL_DEFINITIONS).filter(name => {
    const def = TOOL_DEFINITIONS[name];
    return def.agents.includes('*') || def.agents.includes(functionType);
  });
}

/**
 * 도구 이름 배열을 Anthropic API tools 포맷으로 변환.
 *
 * @param {string[]} toolNames
 * @returns {object[]} Anthropic tools 배열
 */
function buildToolSchemas(toolNames) {
  return toolNames.map(name => {
    const def = TOOL_DEFINITIONS[name];
    if (!def) return null;
    return {
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
    };
  }).filter(Boolean);
}

/**
 * 도구 입력값 기본 검증 (required 필드 체크).
 *
 * @param {string} toolName
 * @param {object} input
 * @returns {{ valid: boolean, error?: string, hint?: string }}
 */
function validateToolInput(toolName, input) {
  const def = TOOL_DEFINITIONS[toolName];
  if (!def) {
    return {
      valid: false,
      error: `Unknown tool: ${toolName}`,
      hint: `Available tools: ${Object.keys(TOOL_DEFINITIONS).join(', ')}`,
    };
  }

  const required = def.input_schema.required || [];
  const missing = required.filter(field => input[field] === undefined || input[field] === null || input[field] === '');
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missing.join(', ')}`,
      hint: `Required: ${required.join(', ')}. Provide all required fields and retry.`,
    };
  }

  // LLM-1/LLM-8: Enforce maxLength constraints declared in input_schema properties
  const props = def.input_schema.properties || {};
  for (const [field, schema] of Object.entries(props)) {
    if (schema.maxLength && typeof input[field] === 'string' && input[field].length > schema.maxLength) {
      return {
        valid: false,
        error: `Field '${field}' exceeds max length (${input[field].length} > ${schema.maxLength})`,
        hint: `Maximum ${schema.maxLength} characters allowed for '${field}'.`,
      };
    }
  }

  return { valid: true };
}

module.exports = {
  TOOL_DEFINITIONS,
  getToolsForFunction,
  buildToolSchemas,
  validateToolInput,
};
