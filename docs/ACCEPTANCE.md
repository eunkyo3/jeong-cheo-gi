# 인수 체크리스트 — 검증 1~9 (계획서 "검증 단계" 대응 + 2026-09-02 개선 라운드)

작성: 2026-08-29, 9절 추가: 2026-09-02. 자동화 가능한 항목은 명령과 결과를 적었고,
**사용자 기기가 필요한 항목은 "사용자 확인" 으로 표시**했다.
자동 게이트 한 번에 재실행: `npm run preflight` (① 단위 → ② 데이터 → ③ 골든 → ④ e2e → ⑤ 커버리지 →
⑥ 해설 → ⑦ 유형 → ⑧ 언어 → ⑨ 문항 서명) + `npm run headless`.

## 1. 데이터 — `npm run validate`

| 기준 | 결과 |
|---|---|
| 21개 회차 전건 PASS | **PASS** — 21 파일, 420 문항, 검증 실패 0건 (`VALIDATION OK`) |
| `excluded.md` 존재 | 존재, **제외 문항 0건** (서술형 11문항은 제외 대신 `keywords` validator 로 수록) |
| `PROGRESS.md` 전 회차 감사통과 | **PASS** — 21 / 21 감사통과. 회차별 워크시트 `data/audits/*.md` 21개 (시드·표본·문항별 판정·근거) |

감사 결과: 21회차 중 10회차에서 **A급 13건** 발견·수정 (전부 해당 회차 전수 재감사 후 PASS), 11회차는 A급 0.
| 회차 | A급 | 내용 |
|---|---|---|
| 2023-3 #15 | 1 | 다이어그램 «import» 라벨을 화살표 2개에 전사 (이미지는 1개) |
| 2022-3 #18 | 1 | E-R 다이어그램 과목코드 밑줄(키) 누락 |
| 2021-2 #3 | 1 | 원자성 keywords 가 지속성 답을 통과시킴 |
| 2020-1 #16 | 1 | 계산식 정답의 정당한 표기 하나 accept 누락 |
| 2020-4 #7, #20 | 2 | 스니핑·가용성 keywords 가 스푸핑·기밀성 답을 통과시킴 |
| 2020-3 #11 | 1 | 1글자 키워드 "형" 이 형상·모형·유형에 부분일치 |
| 2024-3 #9, #13 | 2 | URL 도해 구분자 위치 / 닫힌 보기의 경쟁 항목이 accept 에 혼입 |
| 2024-2 #4 | 1 | 표 셀 1개 오독 (4→2, 10배 확대로 확정; 정답 불변) |
| 2025-2 #11 | 1 | 복원자가 추가한 hint 가 정답을 예시로 노출 — 1차 감사 통과 후 2차 감사자가 발견 (표본 감사 한계 사례) |
| 2023-1 #9, #19 | 2 | 같은 패턴 — 전 회차 기계 검사로 발견. 이후 hint→accept 노출 0건 확인 |

B급(서식) 9건 수정. 감사는 20% 무작위 표본 + 고위험(validator·다필드·코드 블록) 100% 로 평균 실효 커버리지 약 78%, A급 발생 회차는 100%.
감사 중 확정된 판정 세칙은 `data/RESTORE_GUIDE.md` "감사 판정 세칙" 에 기록.

## 2. 단위 테스트 — `npm test`

**PASS** — 87 / 87 (grader 43 · db-adapter 14 [sqlite+json] · ranking 8 · battle 22). 실패 0, skip 0.

## 3. 골든 회귀 — `node scripts/golden-check.mjs`

**PASS** — 문항 20 · display 전수 일치 · 421개 입력 채점 동치 비교 · 차이 11건 전부 `data/grading-diff-whitelist.md` 등재
(Q2/Q5/Q6 keepSpace 재분류에서 나온 의도된 차이만) · Q10 validator 경계 벡터 동일 · 미등재 차이 0건.

## 4. 원격 접속 — **사용자 확인**

| 절차 | 상태 |
|---|---|
| (a) 방화벽 스크립트 실행 **전** 다른 물리 기기에서 `http://<LAN-IP>:3000` 접속 시도 → 결과 기록 | 사용자 확인 |
| (b) `powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1` (관리자) 후 LAN 접속 성공 | 사용자 확인 |
| (c) Tailscale `http://<100.x>:3000` 접속 성공 | 사용자 확인 |

준비된 것: 기동 시 LAN/Tailscale IP 콘솔 출력 확인됨 (`169.254.x` 제외 4개 인터페이스 표시). 방화벽 스크립트는 관리자 권한 검사·중복 규칙 검사·접속 주소 출력 포함.
"같은 PC 두 브라우저" 는 이 항목의 증거로 불인정 (계획서 R7).

## 5. 학습 모드 — `npm run headless` (jsdom, 실서버) + **사용자 확인(모바일)**

| 기준 | 자동 결과 |
|---|---|
| 메인에 21개 회차 버튼 전부 노출 | **PASS** — 21 / 21 (`/api/rounds` 와 일치, 연도 그룹) |
| 채점 3케이스 | **PASS** — 만점(sampleAnswer 전량, grader 자가채점 20/20) · 0점(빈 답안 → 0점) · 부분(4/20 → **20점**) |
| 헤더 "총 N문항 · 100점 만점" 동적 | **PASS** |
| 틀린 문항 복사 버튼 → [문제]/[내 답]/[정답] 3요소 + "풀이 과정을 설명해줘" | **PASS** — 4요소 포함, HTML/엔티티 없음, 정답 카드에는 버튼 없음 |
| 클립보드 폴백 모달 경로 | **PASS** — `navigator.clipboard` 부재 + `execCommand` 실패 → 모달, textarea 전체 선택(0..394/394), 기기별 안내 문구 |
| 이의 제기 → `reports.json` 1건 적재 | **PASS** — `{questionId:"2026-2#3", myAnswer:["ㄴ"], comment, byUserId}` |
| **모바일 브라우저 1대에서 위 흐름 + "길게 눌러 복사" 안내** | 사용자 확인 (Tailscale 폰 접속이 주 사용 형태) |

## 6. 회원 — `npm run headless` + curl

| 기준 | 결과 |
|---|---|
| 가입 → 로그아웃 → 로그인 | **PASS** (headless: 가입→me 반환→로그아웃→me null / curl: 로그인 재성공) |
| 중복 닉네임 거부 메시지 | **PASS** — 400 `{error}` 한국어 메시지 |
| 잘못된 비밀번호 거부 | **PASS** — 401 "닉네임 또는 비밀번호가 올바르지 않습니다." |
| DB 에 해시 저장 | **PASS** — `password_hash` 가 `$2…` bcrypt (평문 아님) |
| 서버 재시작 후 세션 유지 | **PASS** — 서명 키 `data/secret.key` 영속 (db-adapter 영속성 테스트 + 키 파일 재사용 로직) |

## 7. 대전 — `npm run e2e` (실서버 2인 소켓) + `tests/battle.test.mjs` (리듀서 전수)

| 시나리오 | 결과 | 근거 |
|---|---|---|
| 정답 수 차이 → 승자·랭킹 +3/+1 | **PASS** | e2e: winner 결정, ranking `[A:1승 3점] [B:1패 1점]` |
| 동점 선제출 | **PASS** | e2e: 0:0 동점에서 먼저 제출한 A 승 / battle.test 동점 선제출 케이스 |
| 3인전 +3/+1/+1 | **PASS** | ranking.test 3인 매치 |
| 중도 이탈 → 보관 답안으로 채점 | **PASS** | battle.test 일부 이탈 채점 (submitted_at=deadline) |
| 재접속 복원 (resync, 답안 복원, 이탈 표시 안 됨) | **PASS** | e2e: B 재접속 시 `battle:resync` 자동 수신, 입력했던 답 `"B-typed-this"` 복원, remainingMs 599572 |
| 제출 비가역 | **PASS** | e2e: 제출 후 answer → `ALREADY_SUBMITTED` |
| 시간 종료 → 자동 finished, 미제출 deadline 기록, 체인 ③, 완전 동률 무승부 | **PASS** | battle.test: deadline 자동 종료 / 양측 미제출 체인 ③ / 완전 동률 winner null |
| 진행 현황 실시간, 정오 비공개 | **PASS** | e2e: `battle:progress {userId, answeredCount:2}` — `correct` 필드 없음 |
| 치팅 방어 — 페이로드에 accept/sampleAnswer/validator/display 없음 | **PASS** | e2e: `battle:questions` 키 = id,num,prompt,bodyHtml,bodyText,answerMode,fields · fields = `{label}` 만 / curl: `/api/rounds/:id` 동일 |
| 방장 외 시작 거부 / 2인 미만 시작 거부 / countdown 1인 취소 / 전원 이탈 abandoned(미기록) | **PASS** | e2e `NOT_HOST` / battle.test 전이 전수 |
| **브라우저 실기기 대전 UI (로비·대기·대전·결과 4뷰)** | 사용자 확인 | 정적 파일 전부 200, `render(state)` 단방향 규율 코드 검토 완료. 실브라우저 소켓 UI 는 미검증 |

`BATTLE_TIME_OVERRIDE_S` env 지원 확인 (짧은 제한시간 수동 테스트용).

## 8. 랭킹·영속

| 기준 | 결과 |
|---|---|
| 순위·닉네임·승·무·패·승점 표시, 내 순위 강조 | **PASS** (API: `/api/ranking` 컬럼 전부; UI 코드 검토: 내 행 하이라이트) — 실브라우저 표시는 사용자 확인 |
| 서버 재시작 후 계정·전적·랭킹 유지 | **PASS** — db-adapter 영속성 테스트 (sqlite·json 양쪽) |

## 9. 2026-09-02 개선 라운드 (보안·접근성·관리자)

근거: `.omc/handoffs/review-2026-09-02.md` 3리뷰. 자동 게이트는 `npm run preflight`(①~⑨) + `npm run headless` 로 재실행한다.

| 기준 | 확인 방법 | 결과 |
|---|---|---|
| **관리자 로그인** — `/admin.html` 에서 `admin` + 비밀번호로 로그인, 사용자·대전·신고·방·집계가 보인다 | `tests/admin.test.mjs` + 브라우저에서 `/admin.html` 직접 열기 | 자동 테스트 PASS · **실브라우저는 사용자 확인** |
| 관리자 페이지가 일반 내비에 노출되지 않는다 | `public/*.html` 의 내비에 `/admin.html` 링크 0건 | **PASS** |
| 잘못된 관리자 비밀번호·비로그인 접근 거부 | `/api/admin/*` 가 401 | `tests/admin.test.mjs` |
| 기본 관리자 비밀번호로 뜨면 경고가 찍힌다 | 기동 로그에 `[admin] 경고:` 한 줄 | **PASS** (`ADMIN_PASSWORD` 로 바꾸면 사라진다) |
| **채점 401** — 비로그인 채점 거부 | `POST /api/rounds/:id/grade`·`/api/practice/grade` 무쿠키 → 401 | `tests/practice-api.test.mjs` |
| **채점 409** — 진행 중인 대전의 문항은 채점 불가 | 같은 사용자가 playing 방의 문항 id 로 채점 → 409 | `tests/practice-api.test.mjs` |
| **채점 429** — 사용자당 분당 20회 초과 | 21번째 채점 → 429 | `tests/practice-api.test.mjs` |
| 채점 세트를 클라이언트가 정하지 못한다 | `/api/practice/grade` 는 서명 세트 토큰의 문항만 채점, 토큰 밖 id 는 무시 | `tests/settoken.test.mjs` + practice-api |
| **다크 모드** — 기기 밝기 설정을 따라간다 | `prefers-color-scheme: dark` 로 5개 화면 표시 | CSS 토큰 전수 검사 PASS(라이트·다크 대비 AA FAIL 0건) · **실기기 육안은 사용자 확인** |
| 애니메이션 최소화 존중 | `prefers-reduced-motion` 에서 부드러운 스크롤이 즉시 이동으로 | 코드 검토 PASS · 사용자 확인 |
| **모바일 표 스크롤 (대전)** — 표가 든 문항이 대전 풀이·결과에서 가로로 넘치지 않는다 | 좁은 폭에서 표 문항 확인 | `public/js/battle.js` 의 문항 카드·결과 카드·해설 3곳이 전부 `JPK.qbody.decorate`(`.tbl-scroll`) 를 지난다 — 코드 PASS · **실기기는 사용자 확인** |
| **종료 시 DB flush** — `Ctrl+C`/`SIGTERM` 으로 끄면 미저장 쓰기가 남지 않는다 | 종료 → 재기동 후 마지막 쓰기 확인 | `tests/boot.test.mjs` 통합 케이스(자식 프로세스 SIGTERM → exit 0 + `app.json` flush 확인) **PASS** |
| 비정상 종료가 대전을 조용히 삼키지 않는다 | `unhandledRejection` 은 죽이지 않고 로그만, `uncaughtException` 은 정리 후 종료 | `tests/boot.test.mjs` |
| **비밀번호 8자 이상** · scrypt 저장 | 7자 가입 → 400. DB `password_hash` 가 `scrypt$…` (6절의 "bcrypt" 기록은 이 라운드 이전 상태다) | `tests/auth.test.mjs` |
| 세션 쿠키 7일 · 세대 폐기 | `Max-Age=604800`, `session_version` 불일치 쿠키는 비로그인 취급 | `tests/auth.test.mjs` |
| **신고 로그인 필요** · 적재 경로 변경 | 비로그인 `POST /api/reports` → 401. `data/reports.jsonl` 에 한 줄씩, 예전 `reports.json` 은 첫 기동에 `.migrated` 로 이관 | `tests/auth.test.mjs` + `npm run headless` |
| 사이드카 유실·재번호 탐지 | `npm run preflight` ⑥⑦⑧ 이 디렉터리 0개에서 FAIL, ⑨ 가 서명 대조 | **PASS** |

## 사용자 인수 시 남은 항목 요약

1. 검증 4 — 다른 물리 기기 1대 이상에서 방화벽 전/후 LAN 접속, Tailscale 접속.
2. 검증 5 — 모바일 브라우저 1대에서 학습 흐름 + "길게 눌러 복사" 모달.
3. 검증 7/8 — 실브라우저 2대에서 대전 한 판 (로비→대기→대전→결과) 후 랭킹 페이지 확인.
4. ~~감사 21/21 완료 확인~~ — 완료 (2026-08-29).

인수 전 초기화됨: `data/app.db` 삭제(최초 기동 시 재생성), `data/reports.json` = `[]`. 테스트 계정 잔존 없음.
