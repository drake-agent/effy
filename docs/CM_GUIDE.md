# Effy — Configuration Management Guide

형상관리(CM) 전체 구조와 운영 가이드.

---

## 1. 전체 구조 맵

```
effy/
│
├── .github/                          ◆ GitHub 자동화
│   ├── workflows/
│   │   ├── ci.yml                    CI: lint → test → docker build
│   │   └── release.yml              Release: tag → GitHub Release + GHCR
│   ├── pull_request_template.md     PR 템플릿 (보안 체크리스트 포함)
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md            버그 리포트 양식
│       └── feature_request.md       기능 요청 양식
│
├── .husky/                           ◆ Git Hooks (pre-commit)
│   ├── pre-commit                   lint-staged 실행
│   └── commit-msg                   Conventional Commits 검증
│
├── config/                           ◆ 환경별 설정 오버라이드
│   ├── env.development.yaml         개발: 낮은 동시성, debug 로깅
│   ├── env.staging.yaml             스테이징: 중간 예산, info 로깅
│   └── env.production.yaml          프로덕션: warn 로깅만
│
├── scripts/                          ◆ 운영 스크립트
│   ├── release.sh                   시맨틱 버저닝 + 릴리즈 브랜치 생성
│   └── health-check.sh             서비스 헬스 체크
│
├── src/                              ◆ 소스코드
│   ├── config.js                    YAML 로더 + 환경별 deepMerge
│   ├── app.js                       엔트리포인트
│   ├── core/                        게이트웨이 코어 모듈
│   ├── memory/                      메모리 시스템 (4계층 + Graph)
│   ├── agents/                      에이전트 런타임 + 도구
│   ├── gateway/                     메인 파이프라인 + 어댑터
│   ├── github/                      GitHub 웹훅
│   ├── shared/                      공통 유틸리티
│   └── db/                          SQLite 스키마 + WAL
│
├── agents/                           ◆ 선언적 에이전트 정의
│   ├── _base/                       공통 SOUL.md + AGENTS.md
│   └── {general,code,ops,...}/      에이전트별 페르소나
│
├── tests/                            ◆ 테스트
│   ├── tier1-*.test.js              단위 + 보안 테스트 (DB 불필요)
│   └── tier2-*.test.js              통합 테스트
│
├── docs/                             ◆ 문서
│   ├── ARCHITECTURE.md              v1 아키텍처 (레퍼런스)
│   ├── ARCHITECTURE_v3.md           v3 아키텍처
│   └── CM_GUIDE.md                  ← 이 문서
│
├── effy.config.yaml                 베이스 설정 (모든 환경 공통)
├── .env.example                      환경변수 템플릿
├── .editorconfig                     에디터 설정 통일
├── .nvmrc                            Node.js 버전 고정 (20)
├── .gitignore                        Git 추적 제외
├── .dockerignore                     Docker 빌드 컨텍스트 제외
├── .lintstagedrc.json                lint-staged 설정
├── package.json                      의존성 + 스크립트
├── Dockerfile                        멀티스테이지 빌드
├── docker-compose.yml                프로필 기반 환경 실행
├── CHANGELOG.md                      변경 이력 (Keep a Changelog)
├── CONTRIBUTING.md                   기여 가이드 (브랜치/커밋/PR)
├── INSTALL.md                        설치 가이드
└── README.md                         프로젝트 개요
```

---

## 2. 브랜치 전략

```
main ─────────────────────────────────────── production (태그 릴리즈만)
  │                                    ▲
  │                              merge commit
  │                                    │
  └── develop ────────────────── release/v3.6.0 ──┘
        │          ▲
        │     squash merge
        │          │
        ├── feature/Effy-42-graph-search
        ├── fix/Effy-99-null-guard
        ├── refactor/extract-mapper
        └── hotfix/critical-fix ──────────────────→ main (긴급)
```

### 브랜치 규칙

| 브랜치 | 보호 | 머지 방식 | 용도 |
|--------|------|-----------|------|
| `main` | protected, require PR + 1 review | merge commit | 프로덕션 릴리즈만 |
| `develop` | protected, require PR + CI pass | squash merge | 통합 브랜치 |
| `feature/*` | — | → develop | 기능 개발 |
| `fix/*` | — | → develop | 버그 수정 |
| `refactor/*` | — | → develop | 코드 개선 |
| `release/*` | — | → main → develop | 릴리즈 준비 |
| `hotfix/*` | — | → main → develop | 긴급 수정 |

---

## 3. 커밋 컨벤션

### Conventional Commits

```
<type>(<scope>): <description>    ← 72자 이내

[optional body]

[optional footer(s)]
```

### 타입 + 스코프 매트릭스

```
         ┌─────────┬────────┬────────┬──────┬────┬────────┬────────┬────┬────────┐
         │ gateway │ memory │ agents │ core │ db │ shared │ config │ ci │ docker │
┌────────┼─────────┼────────┼────────┼──────┼────┼────────┼────────┼────┼────────┤
│ feat   │    ✓    │   ✓    │   ✓    │  ✓   │ ✓  │   ✓    │   ✓    │    │        │
│ fix    │    ✓    │   ✓    │   ✓    │  ✓   │ ✓  │   ✓    │   ✓    │    │        │
│ refact │    ✓    │   ✓    │   ✓    │  ✓   │ ✓  │   ✓    │        │    │        │
│ perf   │    ✓    │   ✓    │        │  ✓   │ ✓  │        │        │    │        │
│ test   │    ✓    │   ✓    │   ✓    │  ✓   │ ✓  │   ✓    │        │    │        │
│ docs   │    ✓    │   ✓    │   ✓    │      │    │        │        │    │        │
│ chore  │         │        │        │      │    │        │   ✓    │ ✓  │   ✓    │
│security│    ✓    │   ✓    │        │      │ ✓  │   ✓    │        │    │        │
└────────┴─────────┴────────┴────────┴──────┴────┴────────┴────────┴────┴────────┘
```

### 커밋 검증 (자동)

```
.husky/commit-msg
  └── 첫 줄만 추출 (head -1)
      └── regex: ^(feat|fix|refactor|perf|test|docs|chore|security|revert)(\(.+\))?: .{1,72}
          ├── 매칭 → ✅ 통과
          └── 불일치 → ❌ 거부 + 가이드 출력
```

---

## 4. CI/CD 파이프라인

### CI (ci.yml) — push/PR 트리거

```
┌─────────────────────────────────────────────────────────────┐
│  Trigger: push to main/develop, PR to main/develop          │
│  Concurrency: ci-{ref}, cancel-in-progress                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│   │ Lint │   │ Tier-1   │   │ Tier-2   │   │ Validate │   │
│   │      │   │ Unit +   │   │ Integr.  │   │ Config   │   │
│   │ node │   │ Security │   │ Memory   │   │ yaml     │   │
│   │--check   │ 110 tests│   │ 24 tests │   │ parse    │   │
│   └──┬───┘   └────┬─────┘   └────┬─────┘   └──────────┘   │
│      │            │              │                          │
│      └────────────┼──────────────┘                          │
│                   ▼                                         │
│            ┌──────────────┐                                 │
│            │ Docker Build │  (push only, verify)            │
│            │ cache: GHA   │                                 │
│            └──────────────┘                                 │
└─────────────────────────────────────────────────────────────┘
```

### Release (release.yml) — 태그 트리거

```
┌─────────────────────────────────────────────────────────────┐
│  Trigger: push tag v*                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐                                         │
│   │  Full Test   │  npm test (134 tests)                   │
│   └──────┬───────┘                                         │
│          │                                                  │
│    ┌─────┴──────┐                                          │
│    ▼            ▼                                           │
│ ┌──────────┐ ┌────────────────┐                            │
│ │ GitHub   │ │ Docker Image   │                            │
│ │ Release  │ │ Build + Push   │                            │
│ │          │ │                │                            │
│ │ CHANGELOG│ │ → ghcr.io     │                            │
│ │ extract  │ │ tags: semver   │                            │
│ │ → notes  │ │       sha      │                            │
│ └──────────┘ └────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. 환경 설정 계층

### 로딩 순서

```
effy.config.yaml          ← 1. 베이스 (모든 환경 공통)
       │
       ▼
 resolveEnvVars()          ← 2. ${VAR_NAME} → process.env 치환
       │
       ▼
config/env.{NODE_ENV}.yaml ← 3. 환경별 오버라이드 (deepMerge)
       │
       ▼
  하위 호환 매핑            ← 4. cfg.slack, cfg.db, cfg.concurrency 생성
       │
       ▼
     config                 ← 5. 최종 설정 객체 (module.exports)
```

### deepMerge 규칙

```
base: { a: { b: 1, c: 2 }, d: [1,2] }
over: { a: { b: 9 },       d: [3] }
─────────────────────────────────────
result: { a: { b: 9, c: 2 }, d: [3] }
         │         │    │        │
         │         │    │        └── 배열: override 통째 교체
         │         │    └── 객체 내 누락 키: base 유지
         │         └── 객체 내 존재 키: override 우선
         └── 재귀 딥 머지
```

### 환경별 차이점

```
                  development      staging         production
────────────────────────────────────────────────────────────────
concurrency        5               10              20
advancedModel     haiku            sonnet          sonnet
maxTokens         2048             4096            4096
monthlyBudget     $20              $50             $200
channelBudget     $2/day           $5/day          $10/day
circuitBreaker    5 err / 1min     3 err / 15min   3 err / 15min
logging           debug            info            warn
DB path           effy-dev.db     effy-staging.db effy.db
```

---

## 6. Pre-commit Hooks

### 실행 흐름

```
git commit
    │
    ▼
.husky/pre-commit
    │
    ▼
npx lint-staged (.lintstagedrc.json)
    │
    ├── src/**/*.js 변경됨?
    │   ├── node --check (syntax 검증)
    │   └── node --test tests/tier1-security.test.js (보안 테스트)
    │
    ├── tests/**/*.test.js 변경됨?
    │   └── node --check (syntax 검증)
    │
    └── *.yaml 변경됨?
        └── yaml.parse() (YAML 문법 검증)

    ▼
.husky/commit-msg
    │
    └── head -1 → regex 매칭
        ├── ✅ → 커밋 완료
        └── ❌ → 거부 + 가이드
```

---

## 7. Docker 구조

### 멀티스테이지 빌드

```
┌─────────────────────────────────────────┐
│ Stage 1: Builder (node:20-slim)         │
│                                         │
│   apt: python3, make, g++               │
│   COPY package.json + package-lock.json │
│   npm ci --production                   │
│                                         │
│   → node_modules (with native bindings) │
└────────────────┬────────────────────────┘
                 │ COPY --from=builder
                 ▼
┌─────────────────────────────────────────┐
│ Stage 2: Production (node:20-slim)      │
│                                         │
│   node_modules/ (from builder)          │
│   src/                                  │
│   agents/                               │
│   config/                               │
│   effy.config.yaml                     │
│   package.json                          │
│                                         │
│   USER: effy (non-root)               │
│   HEALTHCHECK: /health                  │
│   EXPOSE: 3100                          │
│   CMD: node src/app.js                  │
│                                         │
│   ✓ 빌드 도구 없음 (python, g++ 제외)  │
│   ✓ devDependencies 없음               │
│   ✓ 최소 이미지 크기                    │
└─────────────────────────────────────────┘
```

### Docker Compose 프로필

```
docker compose --profile <name> up --build

┌─────────────────────────────────────────────────────────────────┐
│ Profile: dev                                                    │
│ ├── NODE_ENV=development                                        │
│ ├── Volumes: src/, agents/, config/, yaml (read-only bind)      │
│ └── 소스 변경 시 컨테이너 내부에 즉시 반영 (live reload)        │
├─────────────────────────────────────────────────────────────────┤
│ Profile: staging                                                │
│ ├── NODE_ENV=staging                                            │
│ └── Volume: data only (named volume)                            │
├─────────────────────────────────────────────────────────────────┤
│ Profile: production                                             │
│ ├── NODE_ENV=production                                         │
│ ├── Volume: data only (named volume)                            │
│ └── Resource limits: 512M RAM, 1 CPU                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. 릴리즈 프로세스

### 자동화 흐름

```
개발자                              CI/CD
───────                            ──────

1. develop에서 작업 완료
        │
        ▼
2. ./scripts/release.sh patch
   ├── working tree 검증 (dirty → 거부)
   ├── develop 브랜치 확인
   ├── npm test 실행
   ├── 버전 계산 (3.5.4 → 3.5.5)
   ├── release/v3.5.5 브랜치 생성
   ├── package.json 버전 bump
   ├── CHANGELOG.md 업데이트 대기 (수동)
   └── git commit "chore: release v3.5.5"
        │
        ▼
3. git push → PR 생성 → main
        │                              │
        ▼                              ▼
4. 코드 리뷰 + CI 통과            ci.yml 실행
        │                         (lint, test, docker)
        ▼
5. main에 머지 (merge commit)
        │
        ▼
6. git tag v3.5.5 && git push --tags
        │                              │
        │                              ▼
        │                         release.yml 실행
        │                         ├── npm test
        │                         ├── GitHub Release 생성
        │                         │   └── CHANGELOG → release notes
        │                         └── Docker image → ghcr.io
        │                             ├── v3.5.5
        │                             ├── v3.5
        │                             └── sha-abc1234
        ▼
7. main → develop 역머지
```

### 버전 관리 규칙

```
MAJOR.MINOR.PATCH

MAJOR: 호환성 깨지는 변경 (DB 스키마, API 변경)
MINOR: 새 기능 추가 (하위 호환)
PATCH: 버그 수정, 성능 개선

예시:
  3.5.4 → 3.5.5   patch: 버그 수정
  3.5.5 → 3.6.0   minor: 새 에이전트 타입 추가
  3.6.0 → 4.0.0   major: Memory Graph 스키마 변경
```

---

## 9. 보안 게이트

### PR 머지 전 필수 체크

```
PR 생성
  │
  ├── CI 자동 검증
  │   ├── ✅ lint pass
  │   ├── ✅ tier1 tests pass (보안 테스트 포함)
  │   ├── ✅ tier2 tests pass
  │   └── ✅ config validate pass
  │
  ├── PR 템플릿 체크리스트 (수동)
  │   ├── □ No raw SQL string concatenation
  │   ├── □ FTS5 → sanitizeFtsQuery()
  │   ├── □ No console.log with secrets
  │   ├── □ Input validation at boundaries
  │   ├── □ ?? (not ||) for config defaults
  │   └── □ No silent catch blocks
  │
  └── 리뷰어 1명 이상 approve
      │
      ▼
  머지 허용
```

### 보안 테스트 커버리지

```
tier1-security.test.js
├── SEC-A: Payload Validation (PR/Push)      9 tests
├── SEC-B: Webhook Rate Limiting             3 tests
├── SEC-C: Input Sanitization                6 tests
├── SEC-D: Secret Masking                    2 tests
├── SEC-E: FTS5 Query Sanitization           4 tests
└── SEC-SQL: Parameterized Query 검증        2 tests
                                        ─────────
                                        26 tests
```

---

## 10. 파일 이름 규칙

```
소스코드:    kebab-case.js          budget-gate.js, model-router.js
테스트:      tier{N}-{name}.test.js  tier1-security.test.js
환경설정:    env.{name}.yaml        env.development.yaml
프로젝트 문서: UPPER_CASE.md        README.md, CHANGELOG.md
에이전트:    {id}/SOUL.md           general/SOUL.md
스크립트:    kebab-case.sh          release.sh, health-check.sh
워크플로:    kebab-case.yml         ci.yml, release.yml
```

---

## 11. 팀 온보딩 체크리스트

```
□ 1. 리포지토리 클론
     git clone <repo-url> && cd effy

□ 2. Node.js 버전 맞추기
     nvm use                    # .nvmrc → 20

□ 3. 의존성 설치
     npm install                # husky도 자동 설치 (prepare)

□ 4. 환경변수 설정
     cp .env.example .env
     # .env 편집: ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN

□ 5. DB 초기화
     npm run db:init

□ 6. 설정 검증
     npm run validate

□ 7. 테스트 실행
     npm test                   # 134 tests, 전부 통과 확인

□ 8. 개발 서버 실행
     npm run dev                # --watch 모드

□ 9. 문서 읽기
     - README.md               프로젝트 개요
     - CONTRIBUTING.md         기여 가이드
     - INSTALL.md              상세 설치 가이드
     - docs/CM_GUIDE.md        형상관리 가이드 (이 문서)
     - docs/ARCHITECTURE_v3.md 아키텍처
```

---

## 12. 트러블슈팅

### better-sqlite3 빌드 실패

```bash
# 네이티브 빌드 도구 필요
sudo apt install python3 make g++    # Ubuntu
brew install python3                  # macOS
npm rebuild better-sqlite3
```

### pre-commit hook 우회 (비상시만)

```bash
git commit --no-verify -m "hotfix(gateway): emergency fix"
# ⚠️ 반드시 PR에서 CI 통과 필수
```

### Docker 포트 충돌

```bash
# 프로필 없이 실행하면 아무것도 안 뜸 (의도적)
docker compose up                           # ← 서비스 없음
docker compose --profile dev up --build     # ← 올바른 사용법
```

### 환경별 config 미적용

```bash
# NODE_ENV 확인
echo $NODE_ENV
# config/env.{NODE_ENV}.yaml 파일 존재 확인
ls config/
# 로그에서 확인
# [config] Env override loaded: .../config/env.development.yaml
```
