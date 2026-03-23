# Teams Bot 인프라 설정 가이드

> 내부 ALB(Private) 환경에서 Microsoft Teams Bot을 연동하기 위한 터널링 설정 가이드

## 배경

Microsoft Bot Service는 **인터넷에서** 우리 서버로 POST 요청을 보냅니다.
하지만 회사 ALB(`hub-dev.fnco.co.kr`)는 **내부망 전용**(10.51.x.x)이라 외부 접근 불가합니다.

이를 해결하기 위해 **API Gateway(퍼블릭) → Lambda(VPC 내부) → ECS(직접 IP)** 구조로 터널링합니다.

```
Microsoft Bot Service (인터넷)
  ↓ POST /{service-path}/api/messages
API Gateway HTTP API (퍼블릭)
  https://xxxxxxxx.execute-api.ap-northeast-2.amazonaws.com
  ↓
Lambda (VPC 내부, ECS SG)
  - 타겟 그룹에서 healthy IP 자동 조회
  - ECS 직접 연결 (IP:Port)
  ↓
ECS Fargate (Bot 서비스)
  ↓ 응답
역순으로 반환
```

---

## 사전 준비

- ECS 서비스가 이미 배포되어 있어야 함
- ECS 서비스의 타겟 그룹 ARN 확인
- ECS 서비스의 보안 그룹 ID 확인
- VPC, 서브넷 정보 확인

---

## Step 1: Lambda IAM 역할 생성

```bash
# 1-1. 역할 생성
aws iam create-role \
  --role-name {서비스명}-lambda-proxy \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"lambda.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

# 1-2. 정책 연결
aws iam attach-role-policy --role-name {서비스명}-lambda-proxy \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

aws iam attach-role-policy --role-name {서비스명}-lambda-proxy \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# 1-3. ELB 타겟 조회 권한 추가
aws iam put-role-policy \
  --role-name {서비스명}-lambda-proxy \
  --policy-name elbv2-describe \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":"elasticloadbalancing:DescribeTargetHealth",
      "Resource":"*"
    }]
  }'
```

---

## Step 2: Lambda 함수 생성

### 2-1. 코드 작성 (`lambda-proxy.js`)

```javascript
const http = require('http');
const { ElasticLoadBalancingV2Client, DescribeTargetHealthCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');

const TG_ARN = process.env.TARGET_GROUP_ARN;
const client = new ElasticLoadBalancingV2Client({});

let cachedTarget = null;
let cacheExpiry = 0;

async function getHealthyTarget() {
  const now = Date.now();
  if (cachedTarget && now < cacheExpiry) return cachedTarget;

  const result = await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: TG_ARN }));
  const healthy = result.TargetHealthDescriptions.find(t => t.TargetHealth.State === 'healthy');
  if (!healthy) throw new Error('No healthy targets');

  cachedTarget = { ip: healthy.Target.Id, port: healthy.Target.Port };
  cacheExpiry = now + 30000; // 30초 캐시
  return cachedTarget;
}

exports.handler = async (event) => {
  const path = event.rawPath || event.path || '/';
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const headers = event.headers || {};
  const body = event.body || '';

  let target;
  try {
    target = await getHealthyTarget();
  } catch (err) {
    return { statusCode: 503, body: JSON.stringify({ error: 'No healthy target: ' + err.message }) };
  }

  const options = {
    hostname: target.ip,
    port: target.port,
    path: path,
    method: method,
    headers: {
      'content-type': headers['content-type'] || 'application/json',
      'authorization': headers['authorization'] || '',
    },
    timeout: 25000,
  };

  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: { 'content-type': res.headers['content-type'] || 'application/json' },
          body: data,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 504, body: JSON.stringify({ error: 'Timeout' }) }); });
    req.on('error', (err) => { resolve({ statusCode: 502, body: JSON.stringify({ error: err.message }) }); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
};
```

### 2-2. AWS SDK 번들링 + 배포

```bash
mkdir lambda-bundle && cd lambda-bundle
npm init -y
npm install @aws-sdk/client-elastic-load-balancing-v2
# lambda-proxy.js를 이 폴더에 복사
zip -r lambda-proxy.zip .
```

### 2-3. Lambda 함수 생성

```bash
ROLE_ARN=$(aws iam get-role --role-name {서비스명}-lambda-proxy --query 'Role.Arn' --output text)

aws lambda create-function \
  --function-name {서비스명}-bot-proxy \
  --runtime nodejs22.x \
  --handler lambda-proxy.handler \
  --role "$ROLE_ARN" \
  --zip-file fileb://lambda-proxy.zip \
  --timeout 30 \
  --memory-size 128 \
  --vpc-config SubnetIds={pri-subnet-1},{pri-subnet-2},SecurityGroupIds={ecs-security-group-id} \
  --environment "Variables={TARGET_GROUP_ARN={타겟그룹ARN}}"
```

---

## Step 3: ECS 보안 그룹 인바운드 규칙 추가

**핵심!** Lambda가 ECS SG와 같은 SG를 사용하므로, **자기 자신 SG로부터 port 접근을 허용**해야 합니다.

```bash
aws ec2 authorize-security-group-ingress \
  --group-id {ecs-security-group-id} \
  --protocol tcp \
  --port {서비스포트} \
  --source-group {ecs-security-group-id}
```

> 이 규칙이 없으면 Lambda → ECS 연결 시 **타임아웃** 발생

---

## Step 4: API Gateway HTTP API 생성

### 4-1. API 생성

```bash
API_ID=$(aws apigatewayv2 create-api \
  --name {서비스명}-bot \
  --protocol-type HTTP \
  --query 'ApiId' --output text)
echo "API ID: $API_ID"
echo "Endpoint: https://${API_ID}.execute-api.ap-northeast-2.amazonaws.com"
```

### 4-2. Lambda 통합 생성

```bash
LAMBDA_ARN="arn:aws:lambda:ap-northeast-2:{account-id}:function:{서비스명}-bot-proxy"

# Lambda 호출 권한 부여
aws lambda add-permission \
  --function-name {서비스명}-bot-proxy \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:ap-northeast-2:{account-id}:${API_ID}/*/*"

# 통합 생성
INTEGRATION_ID=$(aws apigatewayv2 create-integration \
  --api-id $API_ID \
  --integration-type AWS_PROXY \
  --integration-uri $LAMBDA_ARN \
  --payload-format-version "2.0" \
  --query 'IntegrationId' --output text)
```

### 4-3. 라우트 생성

```bash
# POST /서비스경로/api/messages (봇 메시지 수신)
aws apigatewayv2 create-route \
  --api-id $API_ID \
  --route-key "POST /{서비스경로}/api/messages" \
  --target "integrations/$INTEGRATION_ID"

# GET /서비스경로/api/health (헬스체크)
aws apigatewayv2 create-route \
  --api-id $API_ID \
  --route-key "GET /{서비스경로}/api/health" \
  --target "integrations/$INTEGRATION_ID"
```

### 4-4. 스테이지 생성 + 자동 배포

```bash
aws apigatewayv2 create-stage \
  --api-id $API_ID \
  --stage-name '$default' \
  --auto-deploy
```

---

## Step 5: Azure Bot 엔드포인트 설정

Azure Portal → Bot Services → 구성:

```
끝점 메시지 보내기: https://{API_ID}.execute-api.ap-northeast-2.amazonaws.com/{서비스경로}/api/messages
```

---

## 검증

```bash
# Health check
curl https://{API_ID}.execute-api.ap-northeast-2.amazonaws.com/{서비스경로}/api/health
# 예상 응답: {"status":"ok","timestamp":"..."}

# Messages (인증 없이 → 401이면 정상)
curl -X POST https://{API_ID}.execute-api.ap-northeast-2.amazonaws.com/{서비스경로}/api/messages \
  -H "Content-Type: application/json" \
  -d '{"type":"message","text":"test"}'
# 예상 응답: Unauthorized Access. Request is not authorized (HTTP 401)
```

---

## 생성된 리소스 정리

| 리소스 | 이름 패턴 | 비고 |
|--------|----------|------|
| API Gateway HTTP API | `{서비스명}-bot` | 퍼블릭 엔드포인트 |
| Lambda | `{서비스명}-bot-proxy` | VPC 내부, ECS SG |
| IAM Role | `{서비스명}-lambda-proxy` | Lambda 실행 역할 |
| SG 인바운드 규칙 | ECS SG self-reference | port {서비스포트} |

---

## 왜 Lambda 프록시 방식인가?

내부 ALB 환경에서 외부 트래픽을 수신하는 방법은 크게 3가지입니다:

| 방법 | 가능 여부 | 사유 |
|------|---------|------|
| API Gateway + VPC Link V2 → 내부 ALB | ❌ | 우리 환경의 내부 ALB에서 `INTEGRATION_NETWORK_FAILURE` 발생. ALB SG/NACL/TLS 모두 확인했으나 Hyperplane ENI → 내부 ALB 네트워크 경로가 확립되지 않음 |
| Lambda → 내부 ALB (DNS 경유) | ❌ | ALB SG 인바운드 정책이 특정 SG만 허용하고 있어 Lambda ENI의 트래픽 수신 불가 (타임아웃) |
| **Lambda → ECS 직접 연결 (타겟 그룹 IP 자동 조회)** | ✅ | ALB 우회. ECS SG에 self-reference 규칙만 추가하면 동작 |

**결론:** 내부 ALB의 보안 그룹 정책이 엄격하게 관리되는 환경에서는 ALB를 경유하지 않고 **ECS에 직접 연결**하는 것이 가장 확실합니다. 타겟 그룹 API(`DescribeTargetHealth`)로 healthy IP를 동적 조회하면 ECS 재배포에도 자동 대응됩니다.

---

## 주의사항

- Lambda가 **타겟 그룹에서 healthy IP를 자동 조회**(30초 캐시)하므로 ECS 재배포 시 IP 변경에 자동 대응됨.
- Lambda의 VPC 서브넷과 보안 그룹은 **ECS 서비스와 동일**하게 설정해야 함.
- Lambda 런타임(Node.js 22)에 AWS SDK가 기본 포함되지 않으므로 `@aws-sdk/client-elastic-load-balancing-v2`를 **번들링**해서 배포해야 함.
- ECS SG 인바운드에 **self-reference 규칙** 없으면 Lambda → ECS 연결 시 타임아웃 발생.

---

## Effy 실제 설정 값 (참고)

```
API Gateway: https://r83p0ef3r0.execute-api.ap-northeast-2.amazonaws.com
Lambda: effy-bot-proxy
IAM Role: effy-lambda-proxy
ECS SG: sg-0e9c0f126a56371e0
Target Group: bo-ane2-tg-dev-ax-svc-effy
서비스 경로: /effy
서비스 포트: 3000
```
