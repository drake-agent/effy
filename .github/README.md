# ax-svc-template

FNCO 서비스 배포를 위한 Next.js 템플릿입니다.
`service.yml`만 수정하면 바로 개발 & 배포할 수 있습니다.

---

## 빠른 시작

### Step 1. service.yml 수정

`.fnco/service.yml` 파일을 열어 서비스 정보를 입력합니다.

```yaml
service:
  team: ax                          # 팀 이름 (최대 4글자)
  name: cos-agt                     # 서비스 이름 (최대 12글자, 인프라 리소스명에 사용)
  displayName: Cosmetics Agent      # 표시 이름 (대시보드에 노출, 자유 형식)
  path: /cosmetics-agent            # 서비스 URL 경로 (/로 시작, 영문·숫자·하이픈만)
  port: 3000                        # 컨테이너 포트 (3000 고정)
  description: 화장품 추천 AI 에이전트  # 서비스 설명 (대시보드에 노출)
```

### Step 2. 로컬 개발

```bash
npm install
npm run dev
```

`service.yml`의 `path`가 자동으로 `basePath`에 적용됩니다.
`.env` 설정 없이 바로 실행됩니다.

- 메인 페이지: `http://localhost:3000/<path>`
- Health Check: `http://localhost:3000/<path>/api/health`

### Step 3. 배포

- **개발 배포**: `main` 브랜치에 push
- **운영 배포**: `v*` 태그 push (예: `v1.0.0`)

---

## 자동으로 세팅되는 것들

| 항목 | 설명 |
|------|------|
| **basePath** | `service.path` → Next.js `basePath` 자동 적용 |
| **Health Check** | `/<path>/api/health` 엔드포인트 내장 |
| **public 폴더** | Next.js 빌드에 필요한 `public/` 폴더 포함 |
| **Dockerfile** | multi-stage 빌드 (standalone 모드) |
| **Tailwind CSS** | v4 기본 세팅 포함 |
| **Analytics SDK** | `src/lib/analytics.ts` 사용량 추적 도구 내장 |
| **NEXT_PUBLIC_* 자동 분리** | Secrets의 `NEXT_PUBLIC_*` 변수를 빌드 타임 build-arg로 자동 주입 |

> `NEXT_PUBLIC_BASE_PATH`를 직접 설정할 필요 없습니다.
> `api/health` 를 직접 만들 필요 없습니다.

---

## 파일 구조

```
ax-svc-template/
├── .fnco/
│   └── service.yml              # ⭐ 서비스 설정 (사용자 수정)
├── .github/
│   ├── workflows/
│   │   └── deploy.yml           # 배포 워크플로우 (수정 불필요)
│   └── infra/                   # AWS 인프라 설정 (수정 불필요)
├── src/
│   ├── lib/
│   │   └── analytics.ts         # Analytics SDK (사용량 추적)
│   └── app/
│       ├── layout.tsx           # 루트 레이아웃
│       ├── page.tsx             # 메인 페이지
│       ├── globals.css          # 글로벌 스타일 (Tailwind)
│       └── api/
│           └── health/
│               └── route.ts     # Health Check (내장, 수정 불필요)
├── public/                      # 정적 파일 (favicon 등)
├── Dockerfile                   # Docker 빌드 (수정 불필요)
├── next.config.ts               # Next.js 설정 (수정 불필요)
├── package.json
└── tsconfig.json
```

### 사용자가 신경 쓸 파일

| 파일 | 용도 |
|------|------|
| `.fnco/service.yml` | 서비스 정보 입력 |
| `src/app/` | 페이지 및 API 개발 |
| `public/` | 정적 파일 추가 |

### 건드리지 않아도 되는 파일

| 파일 | 이유 |
|------|------|
| `src/app/api/health/route.ts` | Health Check 자동 내장 |
| `src/lib/analytics.ts` | 사용량 추적 SDK (복사해서 사용) |
| `next.config.ts` | `service.yml`에서 basePath 자동 읽기 |
| `Dockerfile` | standalone 빌드 + basePath 자동 주입 |
| `.github/` | 배포 자동화 |

---

## service.yml 설정 가이드

### 필수 항목

| 항목 | 설명 | 제한 | 예시 |
|------|------|------|------|
| `service.team` | 팀 이름 | 최대 4글자 | `ax` |
| `service.name` | 서비스 이름 (인프라 리소스명에 사용) | 최대 12글자, 영문·숫자·하이픈만 | `cos-agt` |
| `service.path` | 서비스 URL 경로 | `/`로 시작, 영문·숫자·하이픈만 | `/cosmetics-agent` |
| `service.port` | 컨테이너 포트 | `3000` 고정 | `3000` |

> `<placeholder>` 형태가 남아있으면 배포 시 자동으로 빌드가 실패합니다.

### 선택 항목 (서비스 메타데이터)

메인 대시보드에 표기되는 정보입니다. 필수는 아니지만 서비스를 한눈에 식별할 수 있도록 입력하는 것을 권장합니다.

| 항목 | 설명 | 예시 |
|------|------|------|
| `service.displayName` | 대시보드 표시 이름 (자유 형식) | `Cosmetics Agent` |
| `service.description` | 서비스 설명 | `화장품 추천 AI 에이전트` |

### 선택 항목 (env)

민감하지 않은 환경변수를 추가할 수 있습니다.

```yaml
env:
  NODE_ENV: production
  NEXT_TELEMETRY_DISABLED: 1
  AI_PROVIDER: anthropic
  AWS_REGION: ap-northeast-2
```

> `NEXT_PUBLIC_BASE_PATH`는 `service.path`에서 자동 주입되므로 여기에 넣지 않아도 됩니다.

### 전체 예시

```yaml
service:
  team: ax
  name: cos-agt
  displayName: Cosmetics Agent
  path: /cosmetics-agent
  port: 3000
  description: 화장품 추천 AI 에이전트

env:
  NODE_ENV: production
  NEXT_TELEMETRY_DISABLED: 1
  AI_PROVIDER: anthropic
  AWS_REGION: ap-northeast-2
  S3_BUCKET: bo-ane2-s3-dev-ax
```

---

## Secrets 설정 (비밀변수)

비밀변수는 GitHub Secrets에 `.env` 형식으로 등록합니다.

### 등록 위치

GitHub Repository → Settings → Secrets and variables → Actions → Repository secrets

| 환경 | Secret 이름 |
|------|-------------|
| 개발 | `ENV_FILE_CONTENT_DEV` |
| 운영 | `ENV_FILE_CONTENT_PRD` |

### .env 형식 예시

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
OPENAI_API_KEY=sk-xxxxx
DATABASE_URL=postgresql://user:pass@host:5432/db
```

> 키가 없으면 해당 Secret은 생성되지 않고 스킵됩니다.

---

## 배포 방법

### 개발 (DEV) 배포

```bash
git add .
git commit -m "feat: 새로운 기능 추가"
git push origin main
```

### 운영 (PRD) 배포

```bash
git checkout main && git pull origin main
git tag -a v1.0.0 -m "v1.0.0 릴리즈"
git push origin v1.0.0
```

### 태그 롤백

```bash
git tag -d v1.0.0
git push origin :refs/tags/v1.0.0
```

---

## 배포 흐름

```
1. Validation
   └─ service.yml 필수값 확인 → 미입력 시 빌드 실패

2. Secrets Manager 처리
   └─ GitHub Secrets → AWS Secrets Manager

3. ECR 레포지토리 확인
   └─ 없으면 생성, 있으면 스킵

4. Docker 이미지 빌드 & 푸시
   └─ basePath 자동 주입 (--build-arg)
   └─ NEXT_PUBLIC_* 변수 → build-arg로 자동 주입
   └─ DEV: sha-xxxxxxx, latest
   └─ PRD: v1.0.0, sha-xxxxxxx, latest

5. Target Group / Listener Rule 확인
   └─ 없으면 생성, 있으면 OIDC 설정 업데이트

6. Task Definition 등록
   └─ env, secrets, NEXT_PUBLIC_BASE_PATH 자동 반영

7. ECS Service 배포
   └─ 없으면 생성, 있으면 업데이트
```

---

## 서비스 URL

| 환경 | URL |
|------|-----|
| 로컬 | `http://localhost:3000/<path>` |
| 개발 | `https://hub-dev.fnco.co.kr/<path>` |
| 운영 | `https://hub.fnco.co.kr/<path>` |

---

## Analytics SDK (사용량 추적)

`src/lib/analytics.ts`에 내장된 경량 Analytics SDK입니다. 각 서비스에서 사용자 활동을 추적하려면 아래와 같이 사용합니다.

### 초기화

```typescript
import { initAnalytics } from '@/lib/analytics';

initAnalytics({
  serviceKey: 'my-service',
  name: '홍길동',
  email: 'hong@example.com',
  department: 'AX팀',
});
```

### 페이지 뷰 추적

```typescript
import { trackPageView } from '@/lib/analytics';

trackPageView('/my-page', '페이지 제목');
```

### 클릭 이벤트 추적

```typescript
import { trackClick } from '@/lib/analytics';

trackClick('/my-page', 'btn-submit', '제출', 'button');
```

> 이벤트는 큐에 쌓이고 페이지를 떠날 때 `sendBeacon`으로 일괄 전송됩니다.
> `NEXT_PUBLIC_ADMIN_API_URL` 환경변수가 자동 설정됩니다.

---

## NEXT_PUBLIC_* 변수 처리

GitHub Secrets(`ENV_FILE_CONTENT_DEV/PRD`)에 `NEXT_PUBLIC_*` 변수를 넣으면:

1. Secrets Manager에는 저장되지 않고 **빌드 타임 환경변수**로 분리됩니다
2. Docker build 시 `--build-arg`로 자동 주입됩니다
3. Next.js 클라이언트 번들에 정상적으로 포함됩니다

```env
# ENV_FILE_CONTENT_DEV 예시
NEXT_PUBLIC_ADMIN_API_URL=https://hub-dev.fnco.co.kr
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

> `NEXT_PUBLIC_*`는 빌드 타임에만 필요하므로 런타임 Secrets Manager에 넣으면 동작하지 않습니다. 이 템플릿이 자동으로 분리해줍니다.

---

## 참고 사항

### 포트 변경

기본 포트는 `3000`입니다. 다른 포트가 필요하면 **AX팀에 문의**하세요.

### 리소스 스펙

CPU, Memory, Desired Count는 `deploy.yml`에서 관리됩니다. (service.yml에서 설정하지 않음)

### GitHub Secrets (건드리지 마세요!)

아래 값들은 이미 설정되어 있습니다:

- `AWS_REGION`, `AWS_ROLE_ARN`
- `ECS_EXECUTION_ROLE_ARN`, `ECS_TASK_ROLE_ARN`
- `ECS_CLUSTER_NAME_DEV`, `ECS_CLUSTER_NAME_PRD`
- `VPC_ID_DEV`, `VPC_ID_PRD`
- `SUBNET_PRI_IDS_DEV`, `SUBNET_PRI_IDS_PRD`
- `ALB_LISTENER_ARN_DEV`, `ALB_LISTENER_ARN_PRD`
- `ALB_SECURITY_GROUP_ID_DEV`, `ALB_SECURITY_GROUP_ID_PRD`
- `MS_TENANT_ID` - Microsoft Entra Tenant ID
- `MS_CLIENT_ID_DEV`, `MS_CLIENT_ID_PRD` - 환경별 MS SSO Client ID
- `MS_CLIENT_SECRET_DEV`, `MS_CLIENT_SECRET_PRD` - 환경별 MS SSO Client Secret
