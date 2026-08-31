# 배틀 상태 × 이벤트 격자표 (Phase 4 착수 전 필수 산출물)

`PROTOCOL.md` 의 "Phase 4 착수 전 상태×이벤트 격자표를 그려 미정의 전이 0건을 확인할 것" 에 대한 답이다.

- **상태 5종**: `waiting` / `countdown` / `playing` / `finished` / `abandoned`
- **이벤트 12종**: `join` / `leave` / `start` / `answer` / `submit` / `disconnect` / `connect` / `tick` /
  `timeout(countdown)` / `timeout(deadline)` / `timeout(abandon)` / `timeout(roomGc)`
- **격자 크기: 5 × 12 = 60 셀. 미정의 전이 0건.**

모든 셀은 `server/battle.js` 의 `applyEvent` 에서 명시적으로 구현되어 있으며,
"무시" 셀도 **`lastAt` 클램프 갱신만 수행하고 새 state 객체를 반환**한다(입력 state 는 불변).

공통 규칙:

- `at = Math.max(event.at, state.lastAt)` — 시계 역행 클램프. **모든 셀에 선적용**.
- 소켓 유래 이벤트(`join`/`leave`/`start`/`answer`/`submit`)가 거부되면
  `broadcast{event:"error", to:userId}` 이펙트 1건을 낸다. 내부 이벤트(`tick`/`timeout`/`connect`/`disconnect`)의
  거부는 **조용한 무시**(보낼 대상이 없다).
- `disconnect` 는 `leave` 가 아니다. `disconnect` 는 명부(roster)를 줄이지 않고 `connected=false` 만 만든다.
  명부를 줄이는 것은 `leave` 뿐이며, 그것도 **`playing` 에서는 줄이지 않는다**(이탈자 채점 유지).
- **`playing` 의 `leave` 는 즉시 제출로 간주한다**(비가역). 미제출이었다면 `submittedAt=at` 이 박히므로
  `leave` 도 `submit` 과 마찬가지로 **종료 트리거가 될 수 있다**(이탈로 명부 전원 제출이 완성되는 경우).
- 타이머 key 는 `"{roomId}:{kind}"`. 존재하지 않는 key 의 `cancel` 은 무해(no-op).

---

## 1. `waiting` (12 셀)

| 이벤트 | 결과 상태 | 효과 |
|---|---|---|
| `join` | `waiting` | 신규면 명부 추가, 기존이면 `connected=true`·`left=false` 로 복귀. **방장이 비어 있으면(전원 퇴장 후 GC 유예 중) 입장자가 방장.** `cancel(roomGc)` + `broadcast(room:state)` |
| `leave` | `waiting` | 명부에서 제거. 방장이 나가면 `playerOrder[0]` 로 방장 승계. `broadcast(room:state)`. 0명이 되면 `schedule(roomGc, at+60s)`. 명부에 없는 유저면 **무시(비참가자)** |
| `start` | `countdown` | 방장 + 2인 이상일 때만. `cancel(roomGc)` + `schedule(countdown, at+3s)` + `broadcast(room:state)`. 방장 아님 → **무시(NOT_HOST 에러)**, 2인 미만 → **무시(NEED_TWO_PLAYERS 에러)** |
| `answer` | `waiting` | **무시(NOT_PLAYING 에러)** — 대전 시작 전 |
| `submit` | `waiting` | **무시(NOT_PLAYING 에러)** — 대전 시작 전 |
| `disconnect` | `waiting` | `connected=false` + `broadcast(room:state)`. 전원 끊기면 `schedule(roomGc, at+60s)`. 비참가자면 **무시** |
| `connect` | `waiting` | `connected=true` + `cancel(roomGc)` + `broadcast(room:state)` + `broadcast(battle:resync, to=userId)`. 비참가자면 **무시(멤버십 없음)** |
| `tick` | `waiting` | **무시(대기실에는 남은 시간 개념이 없다)** |
| `timeout(countdown)` | `waiting` | **무시(stale — countdown 취소 시 이미 cancel 됨)** |
| `timeout(deadline)` | `waiting` | **무시(stale — playing 진입 전)** |
| `timeout(abandon)` | `waiting` | **무시(stale — abandon 타이머는 playing 에서만 건다)** |
| `timeout(roomGc)` | 접속자 0 → `abandoned`<br>그 외 → `waiting` | 접속자 0이면 방 파기(`abandoned`, **persist 없음**) + 전 타이머 `cancel`. 누군가 접속해 있으면 **무시(stale)** |

## 2. `countdown` (12 셀)

| 이벤트 | 결과 상태 | 효과 |
|---|---|---|
| `join` | `countdown` | **무시(ROOM_NOT_JOINABLE 에러)** — PROTOCOL "join 은 waiting 에서만" |
| `leave` | 잔여 2인 이상 → `countdown`<br>잔여 1인 이하 → `waiting` | 명부 제거·방장 승계. 잔여 2인 미만이면 `cancel(countdown)` + `waiting` 복귀 + `broadcast(room:state)`, 0명이면 `schedule(roomGc)`. 비참가자면 **무시** |
| `start` | `countdown` | **무시(ALREADY_STARTED 에러)** — 중복 `start` 방어 |
| `answer` | `countdown` | **무시(NOT_PLAYING 에러)** — 문항 미배포 |
| `submit` | `countdown` | **무시(NOT_PLAYING 에러)** |
| `disconnect` | `countdown` | `connected=false` + `broadcast(room:state)`. **카운트다운은 취소하지 않는다** — 명부는 그대로이므로 "1인이 되면 취소" 조건에 걸리지 않는다 |
| `connect` | `countdown` | `connected=true` + `broadcast(room:state)` + `broadcast(battle:resync, to)` |
| `tick` | `countdown` | **무시(3초 구간이라 재동기 불필요, 클라이언트가 로컬 애니메이션)** |
| `timeout(countdown)` | `playing` | `startedAt=at`, `deadline=at+timeLimitS*1000`. `schedule(deadline)` + `broadcast(room:state)` + `broadcast(battle:questions)`. 접속자 0이면 `schedule(abandon, at+60s)` 동시 예약 |
| `timeout(deadline)` | `countdown` | **무시(stale)** |
| `timeout(abandon)` | `countdown` | **무시(stale)** |
| `timeout(roomGc)` | `countdown` | **무시(stale — start 에서 cancel 됨)** |

## 3. `playing` (12 셀)

| 이벤트 | 결과 상태 | 효과 |
|---|---|---|
| `join` | `playing` | **무시(ROOM_NOT_JOINABLE 에러)** — 진행 중 난입 금지 |
| `leave` | 전원 제출 → `finished`<br>그 외 → `playing` | **명부에서 지우지 않는다 — 즉시 제출 간주(비가역).** 미제출이었으면 `submittedAt=at` + **보관 답안 1회 채점 → `marks` 확정** + `broadcast(battle:progress,{submitted:true, answeredCount})`(디바운스 없음). 이어서 `left=true`·`connected=false` + `broadcast(room:state)`. **명부 전원**이 제출을 마쳤으면 즉시 종료 처리(`reason:"allSubmitted"`, 이때 `battle:marks` 는 내지 않는다 — 결과 화면이 대체). 종료되지 않았고 이번에 새로 제출된 것이면 **제출 완료자 전원에게 `broadcast(battle:marks, to=userId)`** 를 1건씩(미제출자에게는 절대 발송 금지). 그다음 접속자 0이면 `schedule(abandon, at+60s)`. 이미 제출한 유저의 `leave` 는 `submittedAt` 을 바꾸지 않고 `battle:progress`·`battle:marks` 도 다시 내지 않는다. 재입장은 없다(어댑터가 `players[uid].left` 로 `join` 재부착을 막는다) |
| `start` | `playing` | **무시(ALREADY_STARTED 에러)** |
| `answer` | `playing` | 제출자면 **무시(ALREADY_SUBMITTED 에러 — 비가역)**. 모르는 문항/필드면 **무시(UNKNOWN_QUESTION/BAD_FIELD 에러)**. 정상이면 답안 보관 + `lastAnswerAt=at` + `broadcast(battle:progress, debounce 400ms)` (**정오 비공개, `answeredCount` 만**) |
| `submit` | 전원 제출 → `finished`<br>그 외 → `playing` | 이미 제출했으면 **무시(ALREADY_SUBMITTED 에러)**. 정상이면 `submittedAt=at` + **보관 답안 1회 채점 → `marks` 확정** + `broadcast(battle:progress)` + `broadcast(room:state)`. **명부 전원**(이탈자 포함 — 이탈은 즉시 제출로 간주된다)이 제출을 마쳤으면 즉시 종료 처리(이때 `battle:marks` 는 내지 않는다 — 결과 화면이 대체). 종료가 아니면 **제출 완료자 전원에게 `broadcast(battle:marks, to=userId)`** 를 1건씩 — 페이로드는 제출자 전원의 `{userId,nickname,marks}` 목록(`playerOrder` 순). **미제출자에게는 절대 발송하지 않는다(room 브로드캐스트 금지)** |
| `disconnect` | `playing` | `connected=false` + `broadcast(room:state)`. 접속자 0이면 `schedule(abandon, at+60s)`. **미제출로 남아 deadline 까지 대기** |
| `connect` | `playing` | `connected=true` + `cancel(abandon)` + `broadcast(room:state)` + `broadcast(battle:resync, to)` — 스냅샷 1회, 이벤트 재생 없음. 수신자가 **제출자면** resync 페이로드에 `marks` 배열을 함께 싣는다(미제출자에게는 필드 없음) |
| `tick` | `at >= deadline` → `finished`<br>그 외 → `playing` | 마감 전이면 `broadcast(battle:tick,{remainingMs})`. **`at >= deadline` 이면 즉시 종료 처리**(절전 복귀 방어 — 서버 재검증) |
| `timeout(countdown)` | `playing` | **무시(stale)** |
| `timeout(deadline)` | `at >= deadline` → `finished`<br>그 외 → `playing` | 정상이면 종료 처리. 타이머가 이르게 깨어났으면 **무시하고 `schedule(deadline)` 재예약** |
| `timeout(abandon)` | 접속자 0 → `abandoned`<br>그 외 → `playing` | 접속자 0이면 `abandoned` + `cancel(deadline)`, **`persist` 이펙트 없음(전적 미기록)**. 누군가 돌아왔으면 **무시(stale)** |
| `timeout(roomGc)` | `playing` | **무시(stale — start 에서 cancel 됨)** |

## 4. `finished` (12 셀)

방은 이미 파기 대상(`isDisposed` = true)이며 `battle-io` 가 레지스트리에서 제거한다.
리듀서에 늦게 도착한 이벤트는 전부 **무시**하고 이펙트를 내지 않는다 — 에러 이벤트조차 내지 않는다
(종료 브로드캐스트 뒤에 에러가 따라붙으면 클라이언트 결과 화면을 망친다).

| 이벤트 | 결과 상태 | 효과 |
|---|---|---|
| `join` | `finished` | **무시(방 파기됨)** |
| `leave` | `finished` | **무시(방 파기됨)** |
| `start` | `finished` | **무시(방 파기됨)** |
| `answer` | `finished` | **무시(대전 종료)** |
| `submit` | `finished` | **무시(대전 종료)** |
| `disconnect` | `finished` | **무시(집계 완료)** |
| `connect` | `finished` | **무시(재접속할 방이 없다)** |
| `tick` | `finished` | **무시(종료됨)** |
| `timeout(countdown)` | `finished` | **무시(stale)** |
| `timeout(deadline)` | `finished` | **무시(종료 시 cancel 됨)** |
| `timeout(abandon)` | `finished` | **무시(종료 시 cancel 됨)** |
| `timeout(roomGc)` | `finished` | **무시(stale)** |

## 5. `abandoned` (12 셀)

`finished` 와 동일하게 전 이벤트 무시. 차이는 **전적이 기록되지 않았다는 것**(`persist` 이펙트 미발생)뿐이다.

| 이벤트 | 결과 상태 | 효과 |
|---|---|---|
| `join` | `abandoned` | **무시(방 파기됨)** |
| `leave` | `abandoned` | **무시(방 파기됨)** |
| `start` | `abandoned` | **무시(방 파기됨)** |
| `answer` | `abandoned` | **무시(방 파기됨)** |
| `submit` | `abandoned` | **무시(방 파기됨)** |
| `disconnect` | `abandoned` | **무시(방 파기됨)** |
| `connect` | `abandoned` | **무시(재접속할 방이 없다)** |
| `tick` | `abandoned` | **무시(방 파기됨)** |
| `timeout(countdown)` | `abandoned` | **무시(stale)** |
| `timeout(deadline)` | `abandoned` | **무시(파기 시 cancel 됨)** |
| `timeout(abandon)` | `abandoned` | **무시(중복 발화)** |
| `timeout(roomGc)` | `abandoned` | **무시(중복 발화)** |

---

## 종료 처리(`finished` 진입) 상세

트리거 2종 — ① `submit` **또는 `leave`(즉시 제출 간주)** 로 **명부 전원**(이탈자 포함) 제출 완료,
② `tick` 또는 `timeout(deadline)` 에서 `at >= deadline`.

이펙트 순서:

1. `cancel(deadline)`, `cancel(abandon)`, `cancel(roomGc)`, `cancel(countdown)`
2. `broadcast(room:state)` — 방 전체
3. `broadcast(battle:finished, to=각 참가자)` — **참가자 수만큼**. `details` 는 수신자 본인 것만 담는다
4. `persist{op:"saveMatch"}` — 1건. `players[]` 각 행은 `{userId, correctCount, score, submittedAt, answers, questionIds, wrongIds}` 이며
   `db.saveMatch` 가 같은 트랜잭션에서 참가자별 `study_results(round='battle')` 1행씩도 함께 쓴다(대전 → 오답노트 합류).

**`battle:marks` 는 이 이펙트 목록에 없다** — 종료로 이어지는 이벤트에서는 정오표를 내지 않는다(3번의 결과 화면이 대체한다).

승자 판정 체인(`pickWinner`):
① `correctCount` 내림차순 → ② 제출 시각 오름차순(**이탈자는 이탈 시각, 끊긴 채 미제출로 남은 유저만 `deadline`**) →
③ 마지막 `answer` 시각 오름차순(**입력 전무는 `deadline`**) → ④ 전부 동률이면 `winnerUserId = null` (무승부).

## 방 파기 신호

PROTOCOL 의 effect 4종을 늘리지 않기 위해 방 파기는 **상태 자체로 표현**한다.
`isDisposed(state)` = `state.state === "finished" || state.state === "abandoned"`.
`battle-io` 는 이 순수 술어 1개만 호출해 레지스트리에서 방을 제거한다(자체 분기 로직 없음).
GC 된 빈 `waiting` 방도 같은 이유로 `abandoned` 로 떨어진다 — "전적 미기록 파기" 라는 의미가 정확히 일치한다.
