# 0.4.0 + MCP Release Checklist (승인 대기)

> 상태: **모든 작업 완료, 사용자 최종 승인 대기.** 승인 시 아래 순서대로
> 실행하면 배포까지 자동으로 이어진다. (0.3.4 = Phase 1 에이전트 자산
> 패치는 별도 예약 배포 — 이 문서와 무관하게 진행됨)

## 승인 시 실행 순서 (0.4.0 — 자동화됨)

1. PR `next/0.4 → main` 머지 (CI green 확인 후)
2. `gh workflow run release.yml --ref main` → "Version Packages" PR 생성
   - **버전이 0.4.0 (minor)인지, changeset 4개(CLI/seed/tagPubSub + 잔여 패치)가
     소비되는지 diff 확인**
3. Version PR 머지 → `gh workflow run release.yml --ref main` → npm 0.4.0 publish
   (Trusted Publishing, 토큰 불필요)
4. 데모 리포 의존성 `^0.4.0` 갱신 + README/문서의 0.4 기능 반영

## MCP 첫 배포 (@leejpsd/nextjs-cache-handler-mcp 0.1.0 — 사용자 액션 1회 필요)

신규 패키지는 Trusted Publishing을 미리 설정할 수 없어 **첫 publish만** 수동:

1. `cd mcp && npm run test` (빌드+스모크 재확인)
2. `npm publish --access public` (npm 로그인/OTP 필요 — 사용자)
3. 이후 npmjs.com에서 이 패키지에도 Trusted Publisher 설정
   (leejpsd / nextjs-cache-handler / release.yml) → 다음부터 자동화 가능

## Phase 4 — publish 후 발견성 배포 (승인 후 제가 실행 가능)

- [ ] 공식 MCP 레지스트리 + Smithery/mcp.so 등록 (mcp/README 기반)
- [ ] skills 레지스트리 노출 확인 (`npx skills add leejpsd/nextjs-cache-handler`)
- [ ] 데모 리포 `.mcp.json` 예제 추가
- [ ] 홍보 재개 (docs/ 초안: fortedigital #152 코멘트 1순위 — 0.4.0 실측
  수치로 업데이트: 시딩 첫요청 HIT, 전파 3ms, Cluster e2e)

## 이번 브랜치에 담긴 것 (검증 증거)

| 항목 | 검증 |
|---|---|
| init/doctor CLI | 유닛 10 + 실Redis doctor 2 + 실제 bin 스모크 |
| 빌드 캐시 시딩 (`/seed`, CLI seed) | 유닛 6 + **실앱 e2e: 콜드 서버 첫 요청 `x-nextjs-cache: HIT`** (15 라우트 + fetch 1건 시딩) |
| tagPubSub 전파 | 유닛 4 + 실Redis 통합 2 — **크로스 인스턴스 3ms** (redis@5/ioredis 모두; 기존 스캔 ~2.1s) |
| Redis Cluster e2e | 실 3-마스터 클러스터 5 테스트 (Lua/CROSSSLOT, per-master SCAN, ISR, pubsub 폴백) + CI 잡 신설 |
| MCP 서버 (7 도구) | stdio JSON-RPC 스모크 + 실Redis 라이브 콜 (health/tag_state/dry-run) |

전체 스위트: 유닛 153 + 통합 25 + 클러스터 5. 코어 zero-dep 유지
(CLI는 node 내장만, MCP는 별도 패키지).

## 남은 리스크 / 알려진 한계

- tagPubSub는 Cluster 클라이언트에서 폴링 폴백 (경고 1회) — 문서화됨
- 시딩: PPR 세그먼트가 불완전한 라우트는 안전하게 스킵 (카운트 보고)
- CI cluster 잡은 이번 PR에서 첫 실행 — 실패 시 머지 전 수정
