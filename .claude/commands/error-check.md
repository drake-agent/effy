# Effy 오류 체크 (1시간 주기)

현재 시간이 KST 09:00~19:00(업무시간) 밖이면 "업무시간 외 — 스킵"만 출력하고 종료.

## 0. 사전 참조
- `.docs/ops-status.md`를 읽어 현재 알려진 이슈, 반복 에러, 무시 가능한 에러 목록을 확인한다.
- `gh issue list --state open --limit 20`으로 GitHub 오픈 이슈를 확인하여 중복 등록을 방지한다.

## 1. 서비스 상태 확인

### 1-1. pm2 상태
```bash
pm2 list
```
- effy 프로세스가 `online` 상태인지 확인
- restart 횟수가 이전 체크 대비 증가했는지 확인 (비정상 재시작 감지)

### 1-2. 에러 로그 확인
```bash
pm2 logs effy --lines 100 --nostream
```
- `[ERROR]`, `[FATAL]`, `crash`, `ECONNREFUSED`, `unhandledRejection`, `uncaughtException` 등 심각한 에러 확인
- `error:`, `Error:`, `failed`, `is not defined`, `is not a function`, `Cannot read` 등 런타임 에러도 확인 (대괄호 없는 에러 로그 포함)
- 반복되는 에러 패턴 감지
- **무시할 알려진 이슈:**
  - Teams 어댑터 에러(`TEAMS_APP_ID/PASSWORD`, `MicrosoftAppId`) — 미설정 상태
  - AgentBus 경고(`commGraph is null`, `mailbox is null`) — 선택 모듈
  - `Unresolved environment variables` 중 TEAMS/DISCORD/NOTION/GOOGLE/REDIS/A2A 관련 — 미사용

### 1-3. Health endpoint
```bash
curl -s http://localhost:3100/health
```

### 1-4. PG 컨테이너 상태
```bash
docker ps --filter name=effy-postgres --format "{{.Names}} {{.Status}}"
```

## 2. 판단

모든 항목 정상이면 "헬스체크 OK" 한 줄만 출력하고 종료.

## 3. 이슈 발견 시

### 3-1. 에러 원인 코드 추적
에러 로그에 파일명/라인 정보가 있으면 해당 소스 코드를 직접 읽어서 원인을 분석한다.

예시:
- `[ERROR] [db:postgres] Query error` → 해당 쿼리를 실행하는 코드 파일 확인 (src/db/ 하위)
- `[ERROR] [gateway] Pipeline error` → src/gateway/gateway.js, src/core/pipeline.js 확인
- `[ERROR] [reflection:distiller]` → src/reflection/distiller.js 확인
- `TypeError: X is not a function` → 스택트레이스에서 파일 경로 추출 후 해당 코드 확인
- `relation "X" does not exist` → src/db/pg-adapter.js 또는 migrations 확인

코드를 읽고 다음을 판단:
- 코드 버그인지, 설정 문제인지, 외부 의존성 문제인지
- 수정이 필요한 파일과 예상 원인
- 긴급도 (서비스 중단 / 기능 장애 / 경미한 경고)

### 3-2. GitHub 이슈 등록
기존 이슈와 중복되지 않는 신규 문제일 경우에만 GitHub 이슈를 등록한다.
```bash
gh issue create --title "[auto] 이슈 제목" --body "본문" --label "bug"
```
- gh CLI가 없으면 이슈 내용을 여기에 출력하고 Slack으로 알린다.

이슈 본문에 포함할 내용:
- 에러 메시지 원문
- 에러 발생 시간 (UTC → KST 변환하여 표기, KST = UTC+9)
- 관련 소스 파일 경로 + 라인
- 원인 분석 결과
- 제안하는 수정 방향

### 3-3. Slack 알림
`work-effy-ops` 채널(C0AMBBLD0RM)에 `mcp__fnf-slack-mcp__slack_send_message`로 알림 전송:

```
⚠️ Effy 헬스체크 이상 감지 (YYYY-MM-DD HH:MM KST)
- 증상: (에러 요약)
- 에러 발생: (최초/최근 발생 시간, KST로 변환)
- 원인: (코드 분석 결과 요약)
- 파일: (관련 소스 경로)
- 긴급도: 높음/중간/낮음
- 조치: GitHub 이슈 #XX 등록 / (또는 즉시 확인 필요)
```

정상일 때는 Slack 알림을 보내지 않는다.

### 3-4. ops-status.md 업데이트
`.docs/ops-status.md`의 반복 에러 테이블, 서비스 상태, 이슈 목록을 최신 상태로 갱신한다.
신규 이슈가 등록되면 테이블에 추가하고, 해결된 이슈는 제거한다.
