# Agent Optimization Plan (0.4.x track)

> 작성: 2026-08-01. 배경: AWS Agent Toolkit의 설치 경험(설치→감지→설정 생성→룰
> 주입→MCP 연동)을 벤치마킹해, 이 패키지를 **에이전트 생태계의 1순위 선택지**로
> 만드는 계획. 이것은 기능 개선이 아니라 유통 전략이다 — 개발자가 npm을
> 검색하는 대신 에이전트에게 "셀프호스팅 Next에 Redis 캐싱 붙여줘"라고 말하는
> 순간, 에이전트가 이 패키지를 고르게 만든다.

## 전체 그림 — 4개 레이어

```
[발견]  에이전트가 패키지를 알게 되는 경로     → 스킬 레지스트리, MCP 레지스트리, llms.txt
[설치]  에이전트가 실행하는 셋업              → agent-executable setup.md + init CLI
[사용]  개발 중 에이전트가 올바르게 쓰게      → SKILL.md + 프로젝트 룰(CLAUDE.md/AGENTS.md) 주입
[운영]  배포 후 에이전트가 캐시를 다루게      → MCP 서버 (검사/무효화/진단 도구)
```

## Phase 1 — 코드 없이 하루 (효과 대비 비용 최소)

### 1-1. Agent Skill (`skills/nextjs-redis-cache/SKILL.md`)
- Claude Code / Codex / Cursor 공용 SKILL.md 표준 포맷.
  (기존 `leejpsd/typescript-react-nextjs-patterns` 스킬 제작 경험 재사용)
- 내용 = 이미 밟아본 지뢰들: Next 15/16 핸들러 선택 결정표, .cjs 셔밍 배선
  레시피, 빌드 페이즈/배포 격리 함정, soft vs hard 무효화 의미론(이슈 #1이
  교보재), CROSSSLOT, 프로덕션 체크리스트, 장애 시 거동. `docs/` 8개 문서를
  에이전트용으로 압축.
- 배포: `npx skills add leejpsd/nextjs-cache-handler` + **npm 타르볼에
  SKILL.md/AGENTS.md 동봉** (에이전트의 node_modules 스캔에 노출).

### 1-2. Agent-executable setup.md (`setup-instructions/setup.md`)
- AWS setup.md 벤치마킹: 에이전트에게 직접 말하는 형식
  (Steps + MUST/MUST NOT + 에러 테이블).
- Steps: ① Next 버전 감지(15→singular만 / 16→둘 다) ② redis vs ioredis
  감지·설치 ③ .cjs 셔밍 2개 + next.config 패치 ④ REDIS_URL /
  DEPLOYMENT_VERSION env 안내 ⑤ 로컬 Redis MISS→HIT 검증 ⑥ 프로젝트
  CLAUDE.md/AGENTS.md에 룰 블록 추가.
- README 최상단에 "For AI agents: give your agent this URL" 섹션 (마케팅 카피 겸용).

### 1-3. 프로젝트 룰 블록 (`rules/nextjs-cache-rules.md`)
- 짧고 명령형: 캐시 무효화 전 스킬 로드 / soft("max") vs hard(updateTag) 구분 /
  DEPLOYMENT_VERSION은 러너 스테이지에 / **AWS 배포는 AWS MCP·스킬과 함께,
  캐시 배선은 이 스킬로** (AWS 연동 지점).

## Phase 2 — `init` / `doctor` CLI

`npx @leejpsd/nextjs-cache-handler init` — 메인 패키지 bin, node 내장만 사용
(**zero-dep 원칙 유지**):

| 단계 | 동작 |
|---|---|
| 감지 | Next 버전, redis/ioredis 유무, App/Pages Router, 기존 cacheHandler 설정 |
| 생성 | cache-components.cjs + cache-incremental.cjs + next.config 패치(diff 제시 후 적용), .env.example |
| 룰 주입 | CLAUDE.md / AGENTS.md / .cursor/rules 감지 후 룰 블록 append |
| 스킬 설치 | ~/.claude/skills 또는 프로젝트 .claude/skills 복사 (선택) |
| 검증 | `doctor`: Redis ping, env 체크, 네임스페이스 키, soft/hard 무효화 스모크 |

`doctor`는 에이전트 트러블슈팅의 첫 실행 커맨드가 되는 것이 목적.

## Phase 3 — MCP 서버 (`@leejpsd/nextjs-cache-handler-mcp`, 별도 패키지)

stdio MCP. 코어 zero-dep 유지를 위해 분리(MCP SDK 의존).

| 도구 | 기능 | 쓰기? |
|---|---|---|
| `cache_health` | ping/레이턴시/메트릭 스냅샷 | 읽기 |
| `cache_inspect` | 키 envelope 디코드(타임스탬프/태그/TTL/압축) | 읽기 |
| `cache_search` | 네임스페이스/패턴 스캔 | 읽기 |
| `tag_state` | 양 계층 태그 마커/상태 조회 | 읽기 |
| `explain_key` | Redis 키 → prefix/kind/ns/key 파싱 | 읽기 |
| `invalidate_tag` | soft/hard 무효화 | **쓰기(기본 dry-run + 확인)** |
| `simulate_swr` | 엔트리+now → fresh/stale/expired 판정 | 읽기 |

`init`이 프로젝트 `.mcp.json`에 등록 → Claude Code 자동 인식. ("캐시가 왜 안
갱신되지?" → 에이전트가 스스로 tag_state 조회하는 경험.)

## Phase 4 — 발견성 배포

- 스킬 레지스트리(npx skills add) / 공식 MCP 레지스트리 + Smithery·mcp.so 등록
- `llms.txt`(요약) / `llms-full.txt`(api.md 기반)
- AWS 연동 e2e 가이드: 데모 리포 Terraform(ECS+ElastiCache) 참조 레시피 —
  "AWS 스킬이 인프라를, 이 스킬이 캐시를" 시나리오 문서화
- 홍보 앵글: "에이전트 네이티브 첫 Next.js 캐시 핸들러"

## 리스크 / 결정 필요

1. **패키징**: init CLI는 메인 패키지 bin(권장, zero-dep 가능) vs 별도 패키지.
   MCP는 SDK 의존 때문에 무조건 별도.
2. **next.config 자동 패치 위험**: 기본은 diff 출력 + 명시 승인, `--yes`에서만 자동.
3. **MCP 쓰기 도구 안전장치**: invalidate_tag는 기본 dry-run.
4. **유지비**: 스킬/룰 버전·옵션 표가 실제 코드와 일치하는지 CI 검사 추가.

## 0.4.0 코어 로드맵 (병행)

| 우선순위 | 작업 | 왜 |
|---|---|---|
| 1 | 빌드 시 캐시 시딩 (registerInitialCache 대응) | 유일한 실질 기능 열세. 배포 직후 재생성 러시 제거 |
| 2 | pub/sub 태그 전파 (SCAN 폴링 → 푸시) | 전파 2.1s → 수십 ms, trieb.work 아키텍처 격차 해소 |
| 3 | Redis Cluster e2e (로컬 멀티노드) | "unit-tested only" 꼬리표 제거 |
| 4 | Vercel KV/Upstash 어댑터 + 'use cache: remote' 멀티티어 | 로드맵 약속분 |
| 5 | 위생: 데모 리포 커밋(soft 프로브·Dockerfile·terraform env), IAM 사용자, 구 AWS 계정 폐쇄(사용자) | |

## 추천 실행 순서

Phase 1 먼저(코드 변경 없음, 즉시 홍보 가능한 차별점) → 0.4.0 코어 1~2번
(시딩 + pub/sub)과 Phase 2(init CLI) 병행 → Phase 3(MCP) → Phase 4(레지스트리).
