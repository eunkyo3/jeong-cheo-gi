# 대전 프로토콜 (동결)

## REST

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/auth/signup` | `{nickname, password}` | `{user:{id,nickname}}` / 400 `{error}` |
| POST | `/api/auth/login` | `{nickname, password}` | `{user:{id,nickname}}` / 401 |
| POST | `/api/auth/logout` | – | `{ok:true}` (쿠키 삭제) |
| GET | `/api/auth/me` | – | `{user}` 또는 `{user:null}` |
| GET | `/api/rounds` | – | `[{round,title,questionCount,counts:{code,sql,theory}}]` (연도 그룹핑은 클라이언트) |
| GET | `/api/rounds/:id` | `?type=code\|sql\|theory` (선택) | `{round,title,sourceUrl,type,questions:[{id,num,prompt,bodyHtml,type,fields:[{label}]}]}` |
| POST | `/api/rounds/:id/grade` | `{answers:{qid:[string]}, type?:"code"\|"sql"\|"theory"}` | `{round,type,correctCount,totalCount,score,details[],bodyTexts{},explanations{}}` (로그인 시 `study_results` 적재) |
| GET | `/api/practice` | `?rounds=all\|<id,id,…>&count=<5..60>&type=` (선택) | `{setKey:"practice", title, roundIds[], type, questions:[…공개 문항]}` / 400 |
| POST | `/api/practice/grade` | `{setKey:"practice"\|"wrong", answers:{qid:[string]}}` | 회차 채점과 동일 형태(`round`=setKey) / 400 |
| GET | `/api/me/history` | – (로그인 필수) | `{rounds:{setKey:{count,best,last,lastAt}}, recent:[{round,score,takenAt,total,correct}](≤20, 최신 먼저), wrongCount}` — `round==="battle"` 인 recent 항목에는 `matchId, roomName` 이 더 붙는다(`match_id` 가 없는 예전 기록은 안 붙는다) |
| GET | `/api/me/wrong` | `?type=` (선택, 로그인 필수) | `{setKey:"wrong", title:"오답노트", type, round:null, questions:[…공개 문항]}` |
| GET | `/api/me/wrong` | `?round=<회차 id>[&type=]` | 그 회차의 **현재 오답**만. `title:"오답노트 · 2024년 1회"`, `round` 는 회차 id / 없는 회차는 400 |
| GET | `/api/me/wrong` | `?match=<매치 id>[&type=]` | **그 대전에서 틀린 문항 전부**(지금은 맞힌 것 포함, 과거 스냅샷). `{…, title:"오답노트 · 대전 <방이름>", match, battle:{…아래 대전 머리말}, resolvedIds:[지금은 오답이 아닌 id], questions}` / 정수가 아닌 값 400 / 내 대전이 아니거나 없는 id 404 |
| GET | `/api/me/wrong/summary` | – (로그인 필수) | `{total, byRound:[{round,title,count,counts:{code,sql,theory}}], byBattle:[{…대전 머리말, wrongCount, stillWrongCount, wrongQuestions:[{id,num,prompt,type,stillWrong}]}]}` — byRound 는 회차 순·오답 0 인 회차 제외, byBattle 은 최신 먼저 |
| POST | `/api/reports` | `{questionId, myAnswer, comment}` | `{ok:true}` → `data/reports.json` 적재 |
| POST | `/api/rooms` | `{name, mode:"round"\|"random", roundIds[], questionCount(5\|10\|20, random만), type?:"code"\|"sql"\|"theory", timeLimitS(600\|1200\|1800), inviteUserIds?:number[](최대 8, 생성자·정수 아닌 값 무시)}` | `{roomId}` |
| GET | `/api/rooms` | – | `[{roomId,name,host,playerCount,mode,state,questionCount,type,timeLimitS}]` (waiting 이면서 참가자 1명 이상인 방만 — 전원 퇴장 후 GC 유예 중인 빈 방은 제외) |
| GET | `/api/ranking` | – | `[{rank,userId,nickname,wins,draws,losses,points}]` |

**에러 규약**: REST 는 400 `{error:"사유"}` (잘못된 설정값, **선택 회차의 유효 문항 총합 < questionCount**),
401(미로그인), 404(없는 방/회차, **내 것이 아니거나 없는 매치 id**). 소켓은 `error` 이벤트 `{code, message}`.

**모의고사·오답노트**: `/api/practice` 는 `battle.js` 의 `buildQuestionSet({mode:'random'})` 을 그대로 쓴다(회차별 균등 배분).
`/api/practice/grade` 는 회차가 고정돼 있지 않으므로 **제출한 `answers` 의 키**로 문항 집합을 복원한다 —
모르는 문항 id 는 무시하고, 실존 문항이 0개면 400, 한 번에 최대 200문항까지 채점한다.
오답노트 판정은 **문항별 가장 최근 채점 결과**를 따른다: `wrong_ids` 에 있으면 오답, `question_ids` 에만 있으면 해제.
`question_ids` 가 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.

**오답노트 허브 — 회차별 / 대전별 (동결)**

같은 오답을 두 관점으로 본다. 둘은 성격이 달라 **섞어 쓸 수 없다**(`?round=` 와 `?match=` 동시 지정은 400).

| 관점 | 뜻 | 경로 |
|---|---|---|
| 회차별 | **지금 오답**(현재 상태). 다시 맞히면 목록에서 빠진다 | `GET /api/me/wrong?round=` |
| 대전별 | **그 대전에서 틀린 문항**(과거 스냅샷). 다시 맞혀도 목록에 남고 `resolvedIds`·`stillWrong` 으로만 표시된다 | `GET /api/me/wrong?match=` |

대전 머리말(`byBattle` 항목 / `?match=` 의 `battle`)은 한 모양이다 —
`{matchId, roomName, finishedAt, mode, roundIds, questionCount, me:{correctCount,score}, opponents:[{nickname,correctCount}], result:"win"|"lose"|"draw"}`.
`result` 는 `matches.winner_user_id` 기준이고 상대의 **보관 답안은 어떤 조회에도 실리지 않는다**(닉네임·정답 수만).

대전을 오답노트에 묶는 연결고리는 `study_results.match_id` 다(SCHEMA.md). 이 값이 NULL 인 예전 기록은
`byBattle` 에서만 빠지고 **회차별 집계·`wrongCount` 에는 그대로 든다** — `scripts/backfill-battle-notes.mjs` 가 소급해 채운다.
소유권 검사는 "내가 참가한 매치만 조회"로 끝난다 — 남의 매치 id 는 존재 여부조차 알리지 않고 404 다.
`stillWrong`·`resolvedIds` 는 **정오 이력**이지 정답 정보가 아니며, 문항은 여전히 `publicQuestion()` 화이트리스트로만 나간다
(`/api/me/wrong/summary` 의 `wrongQuestions` 는 `id`·`num`·`prompt`·`type` 만 싣는 더 좁은 목록이다).

**치팅 방어**: `/api/rounds/:id` 와 `battle:questions` 페이로드에서 `accept`·`sampleAnswer`·`validator`·`display`
를 **반드시 제거**한다. `fields` 는 `{label}` 만 남긴다. 채점은 서버에서만 한다.
`bodyText`(지문 평문)·`type`(문항 유형) 은 정답 정보가 아니므로 `battle:questions` 에는 포함한다(각각 결과 화면 AI 질문 복사용·유형 뱃지용).
`/api/rounds/:id` 는 학습 모드 채점 응답의 `bodyTexts` 맵으로 채점 후에만 내보낸다. `sourceImages` 는 어느 쪽에도 보내지 않는다.
회차 id 는 **인메모리 화이트리스트**로 검사해 경로 순회를 차단한다.

### 문항 유형 필터 (동결)

문항 분류(`data/types/*.json`, SCHEMA.md)는 서버가 기동 시 문항 객체에 `type` 으로 붙인다.
값은 `code` / `sql` / `theory` **셋뿐**이고, 분류가 없는 문항은 **`theory`** 로 떨어진다 — `type` 은 언제나 이 셋 중 하나다.

**`type` 은 정답 정보가 아니다.** `rounds.publicQuestion()` · `battle.publicQuestion()` 화이트리스트에 **올라가 있어**
`/api/rounds/:id`·`/api/practice`·`/api/me/wrong`·`battle:questions`·`battle:resync` 어디서나 **채점 전에도** 나간다
(문항 카드의 유형 뱃지·유형 필터에 필요하다). 해설(`explanationHtml`)과는 정반대 취급이다.

**파라미터 규칙 (다섯 곳 공통)**

| 경로 | 자리 | 효과 |
|---|---|---|
| `GET /api/rounds/:id` | 쿼리 `?type=` | 그 유형 문항만 |
| `POST /api/rounds/:id/grade` | 본문 `type` | **그 부분집합만 채점** — `totalCount`·`score`·`details`·`bodyTexts`·`explanations`·`study_results.question_ids` 가 전부 부분집합 기준. 응답의 `round` 는 회차 id 그대로다(이력 집계 키) |
| `GET /api/practice` | 쿼리 `?type=` | 출제 **풀을 먼저 좁힌 뒤** `buildQuestionSet` |
| `GET /api/me/wrong` | 쿼리 `?type=` | 오답노트 문항 필터. `?round=`·`?match=` 위에 겹쳐 걸린다 |
| `POST /api/rooms` | 본문 `type` | 출제 풀 필터. **방 생성 시 1회만** 적용되고 `settings.type` 으로 보존된다 |

- **미지정·빈 값·`"all"` = 전체**(응답의 `type` 은 `null`). 값 주위 공백은 무시한다.
- 그 밖의 값(`CODE`, `code,sql`, 비문자열 …)은 **400** `{error:"유형은 code/sql/theory 중 하나여야 합니다."}`.
- 필터 결과가 **0문항**이면 400 `{error:"해당 유형의 문항이 없습니다."}` —
  `GET /api/rounds/:id`, `POST /api/rounds/:id/grade`, `POST /api/rooms` 에 적용된다.
  `GET /api/me/wrong` 은 **예외**로, 오답이 없는 상태가 정상이므로 빈 목록을 200 으로 돌려준다.
  `GET /api/practice` 는 풀이 `count` 보다 적을 때 기존 사유(`선택 회차의 유효 문항 총합…`)로 400 이 난다.
- **채점 총점이 부분집합 기준으로 바뀌므로** `study_results.question_ids` 도 같은 부분집합이어야 오답노트가 어긋나지 않는다 —
  `grade` 는 필터된 문항 배열 하나를 채점·저장·응답에 모두 돌려 쓴다.
- **대전은 방 생성 시 1회만** 필터한다. 양쪽이 같은 문항을 봐야 하므로 진행 중 변경은 없고,
  `room:state`·`battle:resync` 의 `settings.type` 과 `GET /api/rooms` 행의 `type` 으로 표시만 한다(전체면 `null`).

### 해설 — 채점 전 비노출 (동결)

문항 해설(`data/explanations/*.json`, SCHEMA.md)은 정답을 그대로 서술한다. 서버는 기동 시 이를 읽어
문항 객체에 `explanationHtml` 로 붙이지만 **이 필드는 내부 전용**이다.

- **나가지 않는 곳**: `GET /api/rounds/:id`, `GET /api/practice`, `GET /api/me/wrong`(`?round=`·`?match=` 포함),
  `GET /api/me/wrong/summary`, `battle:questions`, `battle:resync`, `battle:marks` — 전부 `publicQuestion()`
  화이트리스트(요약은 `id`·`num`·`prompt`·`type` 만 싣는 더 좁은 목록)를 거치므로 `explanationHtml` 은 구조적으로 실리지 않는다.
- **나가는 곳(채점 후에만)**:
  - `POST /api/rounds/:id/grade` · `POST /api/practice/grade` → 최상위 `explanations: {qid: html}`
    (`bodyTexts` 와 같은 패턴. 해설이 없는 문항은 **빈 문자열**이므로 키는 언제나 전 문항을 덮는다)
  - `battle:finished` → 최상위 `explanations: {qid: html}` (수신자와 무관하게 **모두 같은 맵**)

프런트는 채점 결과에서만 이 맵을 읽어 "해설 보기" 토글로 `.explain-box` 에 `innerHTML` 로 넣는다 —
서버가 `validate:explain` 으로 태그 화이트리스트를 강제한 신뢰 마크업이기 때문이다.
해설이 빈 문자열인 문항에는 버튼 자체를 만들지 않는다.

### 상대 답안 — 종료 전 비노출 (동결)

결과 화면에서 "상대는 뭐라고 썼나"를 보여 주기 위해 `battle:finished` 에만 두 맵을 싣는다.
남이 입력한 값은 **정답 정보나 다름없으므로**(먼저 제출한 사람의 답을 베낄 수 있다) 종료 전에는 어떤 경로로도 나가지 않는다.

- `answersByUser: { [userId]: { [qid]: string[] } }` — 참가자별 **보관 답안**. 전 문항 키를 덮고
  배열 길이는 그 문항의 필드 수와 같다(**미입력 칸은 빈 문자열**). 이탈자·미제출자도 그때까지 보관된 답안 그대로 실린다.
- `marksByUser: { [userId]: { [qid]: boolean } }` — 참가자별 **문항 정오 불리언**. 종료 채점(`gradeSet`) 결과에서 뽑는다.
- 둘 다 **수신자와 무관하게 같은 맵**이다(`details` 만 본인 것). 종료 트리거(전원 제출 / 이탈로 완성된 전원 제출 / deadline)와
  무관하게 언제나 실린다.
- **나가지 않는 곳**: `battle:questions`, `battle:resync`, `battle:marks`, `battle:progress`, `room:state` —
  이 이벤트들의 페이로드에는 두 키가 **구조적으로 없다**(`tests/battle.test.mjs` 의 부재 단위 검사 +
  `scripts/e2e-battle.js` 의 종료 전 페이로드 문자열 스캔으로 고정한다).
- 크기: 최대 8인 × 60문항이라 페이로드 부담이 없다.

## 소켓 이벤트 (전 이벤트 서버 권위, 클라이언트는 표시만)

| 이벤트 | 방향 | 페이로드 |
|---|---|---|
| `room:join` | C→S | `{roomId}` — waiting 상태에서만 허용 |
| `room:leave` | C→S | `{}` |
| `room:start` | C→S | `{}` — 방장 소켓 + 2인 이상 검증 |
| `room:invite` | S→C | `{roomId, name, fromUserId, fromNickname, settings:{mode, roundIds, questionCount, type, timeLimitS}}` — `POST /api/rooms` 의 `inviteUserIds` 중 **지금 소켓이 붙어 있는** 대상에게 1회 배달. 상태를 만들지 않으며(보관·재시도 없음) 받은 쪽이 `room:join` 을 보내야 참가다 |
| `room:state` | S→C | `{state, players:[{userId,nickname,connected}], settings:{roomId,name,hostUserId,mode,roundIds,questionCount,type,timeLimitS}}` — 방 상태 변경 시 브로드캐스트. `settings.type` 은 방 생성 시 고정된 유형(전체면 `null`) |
| `battle:questions` | S→C | `{questions[](정답·sampleAnswer 제외, 각 문항에 `type` 포함), deadlineInfo}` — countdown 종료 시 |
| `battle:answer` | C→S | `{questionId, fieldIndex, value}` — 서버가 실시간 보관(제출 아님) |
| `battle:progress` | S→C | `{userId, answeredCount}` — 400ms 디바운스 브로드캐스트, **정오 비공개** |
| `battle:submit` | C→S | `{}` — **명시적·비가역**. 서버가 submitted_at 기록, 이후 `battle:answer` 거부 |
| `battle:marks` | S→C | `{players:[{userId, nickname, marks:{"<qid>": true\|false}}]}` — **제출자에게만 개별 발송(`to=userId`)**. 새 제출이 생길 때마다 제출 완료자 전원에게 최신 전체 목록 재발송. **정오 불리언만** |
| `battle:tick` | S→C | `{remainingMs}` — 10초 주기 재동기 |
| `battle:resync` | S→C | `{state, questions, myAnswers, remainingMs, players[], marks?}` — 재접속 시 **스냅샷 1회** (이벤트 재생 금지). `marks` 는 수신자가 제출자이고 `state==="playing"` 일 때만 실린다 |
| `battle:finished` | S→C | `{results:[{userId,correctCount,score,submittedAt}], winnerUserId(무승부 null), details[](문항별 정오·display), explanations:{qid:html}, answersByUser:{userId:{qid:[입력값]}}, marksByUser:{userId:{qid:bool}}}` — 뒤의 두 맵은 **전원 답안·정오**로, 수신자와 무관하게 모두 같다(결과 화면 상대 답안 표시용) |

**제출자 간 정오 공유 (`battle:marks`)**: 먼저 제출한 사람이 결과를 기다리는 동안 서로의 정오만 확인할 수 있게 한다.

- **제출을 마친 참가자에게만** `to=userId` 로 개별 발송한다. **room 브로드캐스트 금지** — 미제출자에게 새면 치팅이다.
- 담기는 것은 **문항별 정오 불리언뿐**이다. 입력한 답 내용도 `display`(정답 표기)도 절대 포함하지 않는다.
- 트리거는 **새 제출**이다(`submit`, 그리고 즉시 제출로 간주되는 `playing` 중 `leave`).
  그때마다 제출 완료자 **전원**에게 그 시점의 전체 목록(`playerOrder` 순)을 다시 보낸다.
  이미 제출한 사람의 `leave` 는 새 제출이 아니므로 재발송하지 않는다.
- 채점은 **제출 확정 순간 1회**만 한다(답안이 비가역으로 고정되므로 재채점이 없다).
- **종료(`finished`)로 이어지는 이벤트에서는 보내지 않는다** — `battle:finished` 의 결과 화면이 대체한다.
  종료 이후에도 보내지 않는다.
- 재접속: `battle:resync` 의 최상위 `marks` 필드로 같은 배열을 재전송한다. 수신자가 미제출이면 **필드 자체가 없다**.

## 상태 머신

```
waiting → countdown(3s) → playing → finished(방 파기)
                                  ↘ abandoned (예외)
```

전이 규칙:
- `join` 은 **waiting 에서만**.
- `start` 는 **방장 + 2인 이상**.
- countdown 중 1인이 되면 **취소 → waiting**.
- **playing → finished 트리거 2종**: ① 전원 제출, ② deadline 경과(서버 재검증).
  **"전원"은 이탈자를 포함한다** — 이탈(`room:leave`)은 **즉시 제출로 간주**하므로(아래) 이탈만으로
  전원 제출이 완성되면 그 순간 `finished` 가 된다.
- playing 중 **`room:leave` 는 즉시 제출**이다(비가역): 그때까지 보관된 답안이 그대로 확정되고
  `submitted_at = 이탈 시각` 이 박힌다. 명부에는 남아 채점되며 **재입장은 없다**
  (`room:join` 은 `players[uid].left` 를 보고 거부된다).
- playing 중 **전원 끊김 60초 유예** 후 `abandoned` (전적 미기록). 종료되지 않은 경우에만 건다.
- 일부 이탈자는 **보관 답안으로 채점 유지** (`submitted_at = 이탈 시각`).
  `disconnect` 는 이탈이 아니다 — 끊긴 채 돌아오지 않으면 미제출로 남아 판정 시각만 `deadline` 이 된다.
- `finished` 후 방 파기. 빈 `waiting` 방은 60초 후 삭제.

**Phase 4 착수 전 상태×이벤트 격자표를 그려 미정의 전이 0건을 확인할 것.**

## 리듀서 계약 (`server/battle.js`)

```js
applyEvent(state, event) → { state, effects: [] }
```

- **순수 함수.** I/O·타이머·소켓 접근 금지. `Date.now()` 호출 금지.
- 시간은 `event.at` (epoch ms) 주입. `at = Math.max(event.at, state.lastAt)` 로 **클램프**(시계 역행 방어).
- **effects 4종** — 영속화·타이머 결정까지 리듀서가 담당한다:
  | effect | 형태 | battle-io 의 위임 대상 |
  |---|---|---|
  | `broadcast` | `{type:'broadcast', room, event, payload, to?}` | 소켓 `emit` |
  | `persist` | `{type:'persist', op:'saveMatch', match, players}` | `db` 호출 |
  | `schedule` | `{type:'schedule', key, at, timeout:{kind,...}}` | `setTimeout` |
  | `cancel` | `{type:'cancel', key}` | `clearTimeout` |
- **내부 이벤트 어휘** (소켓 이벤트와 별도):
  `tick(at)` / `timeout(kind: countdown|deadline|abandon|roomGc)` / `disconnect(userId)` / `connect(userId)`
  그리고 소켓 유래: `join` / `leave` / `start` / `answer` / `submit`
- `persist{op:'saveMatch'}` 의 `players[]` 각 행은 `{userId, correctCount, score, submittedAt, answers, questionIds, wrongIds}` 다.
  **`db.saveMatch` 는 매치·참가자와 같은 트랜잭션(json 어댑터는 같은 flush)에서
  참가자별 `study_results(round='battle', score, question_ids, wrong_ids)` 1행씩도 함께 쓴다** —
  대전 기록이 학습 이력·오답노트에 그대로 합류한다(`taken_at` = 매치 종료 시각).
  `questionIds`/`wrongIds` 가 없는 예전 호출자는 매치만 남기고 학습 기록은 건너뛴다.
  이 변경 이전에 끝난 매치는 `scripts/backfill-battle-notes.mjs` 로 소급 적재한다(멱등).

`server/battle-io.js` 는 **effects 4종을 각각 emit / db / setTimeout / clearTimeout 에 1:1 위임하는
무논리 어댑터**다. 자체 분기 로직 금지.

- 소켓 인증: `io.use()` 에서 쿠키 HMAC 검증 → `socket.data.user` 주입, 실패 시 거부.
- 멤버십은 **userId 기준 Map**. 동일 유저 다중 탭은 **최신 소켓만 유효**(이전 강제 종료).
- 재접속: **인증 성공 직후 서버가 멤버십을 조회해 `battle:resync` 를 자동 emit** (`room:join` 불필요).
- 타이머: `battle:tick` 10초 주기. 클라이언트는 `performance.now()` 감산 표시.
  종료 판정은 서버가 `Date.now() >= deadline` 을 **재검증**(절전 복귀 시 즉시 종료 처리).

## 승자 판정 체인

① 정답 수 → ② 제출 시각(**이탈자는 이탈 시각, 끊긴 채 미제출로 남은 유저만 deadline**) → ③ 마지막 `battle:answer` 시각(입력 전무 시 deadline)
→ ④ 전부 동률이면 **무승부** (`winner_user_id` NULL).

## 랭킹 규칙

매치당 1등 **+3점**, 그 외 참가 **+1점**, 무승부 매치는 **전원 +1점**(1등 없음).
표시 컬럼: 순위·닉네임·승·무·패(= 참가 − 승 − 무)·승점. 정렬: 승점 → 승수 → 닉네임.
집계는 `ranking.js` 의 JS 에서 수행한다(db 어댑터는 raw row 만 반환).

## 랜덤 출제

선택 회차에서 **회차별 균등 배분, 나머지 문항은 전체 풀에서 무작위**
(예: 3회차 10문항 = 3/3/3 + 1 무작위). **동일 문항 중복 금지.**
선택 회차의 유효 문항 총합 < `questionCount` 이면 400.

## battle.html 문항 UI 모델

**전 문항 세로 나열식** (study 패턴 계승, 문항 단위 네비게이션 없음).
`battle:answer` 는 입력 필드의 `input` 이벤트에서 **400ms 디바운스**로 전송.
`answeredCount` = **모든 필드가 비어 있지 않은 문항 수**(서버 계산).
"다른 문항으로 이동" 개념은 사용하지 않는다.

프런트는 **이벤트 → state → `render(state)` 전체 재렌더** 단방향만 허용한다. **부분 DOM 패치 금지.**
유일한 예외: 제출 버튼 옆 **"답한 문항 n/N"** 텍스트(`syncAnsweredCount`)는 입력마다 바뀌어야 하는데 입력값이 패널 key 에
들어갈 수 없으므로(한글 IME 보호) 텍스트 노드 하나만 직접 갱신한다. 셈 규칙은 서버 `answeredCount` 와 같다(모든 칸이 차야 답함).

## 클립보드 방침

`http://<IP>` 원격 접속은 secure context 가 아니어서 `navigator.clipboard` 가 **존재하지 않는다 —
폴백이 기본 경로다.** `public/js/clipboard.js` 3단 폴백:

1. `navigator.clipboard.writeText()` **호출 성공 여부**로 분기.
   존재 검사 금지. **속성 접근까지 try/catch 로 감싸** undefined 동기 TypeError 도 2단계로 폴백한다
   (비보안 컨텍스트에서 객체만 노출되는 브라우저 포함).
2. `document.execCommand('copy')` (textarea 선택).
3. 프롬프트 전문 textarea 모달을 **전체 선택 상태**로 열고 기기별 안내
   (데스크톱 "Ctrl+C", 모바일 "길게 눌러 복사").

복사 내용: `[문제]`(bodyText) + `[내 답]` + `[정답]`(display) + `"풀이 과정을 설명해줘"`.
