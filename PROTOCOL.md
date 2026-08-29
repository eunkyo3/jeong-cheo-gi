# 대전 프로토콜 (동결)

## REST

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/api/auth/signup` | `{nickname, password}` | `{user:{id,nickname}}` / 400 `{error}` |
| POST | `/api/auth/login` | `{nickname, password}` | `{user:{id,nickname}}` / 401 |
| POST | `/api/auth/logout` | – | `{ok:true}` (쿠키 삭제) |
| GET | `/api/auth/me` | – | `{user}` 또는 `{user:null}` |
| GET | `/api/rounds` | – | `[{round,title,questionCount}]` (연도 그룹핑은 클라이언트) |
| GET | `/api/rounds/:id` | – | `{round,title,sourceUrl,questions:[{id,num,prompt,bodyHtml,fields:[{label}]}]}` |
| POST | `/api/rounds/:id/grade` | `{answers:{qid:[string]}}` | `{round,correctCount,totalCount,score,details[],bodyTexts{}}` (로그인 시 `study_results` 적재) |
| GET | `/api/practice` | `?rounds=all\|<id,id,…>&count=<5..60>` | `{setKey:"practice", title, roundIds[], questions:[{id,num,prompt,bodyHtml,fields:[{label}]}]}` / 400 |
| POST | `/api/practice/grade` | `{setKey:"practice"\|"wrong", answers:{qid:[string]}}` | 회차 채점과 동일 형태(`round`=setKey) / 400 |
| GET | `/api/me/history` | – (로그인 필수) | `{rounds:{setKey:{count,best,last,lastAt}}, recent:[{round,score,takenAt,total,correct}](≤20, 최신 먼저), wrongCount}` |
| GET | `/api/me/wrong` | – (로그인 필수) | `{setKey:"wrong", title:"오답노트", questions:[…공개 문항]}` |
| POST | `/api/reports` | `{questionId, myAnswer, comment}` | `{ok:true}` → `data/reports.json` 적재 |
| POST | `/api/rooms` | `{name, mode:"round"\|"random", roundIds[], questionCount(5\|10\|20, random만), timeLimitS(600\|1200\|1800), inviteUserIds?:number[](최대 8, 생성자·정수 아닌 값 무시)}` | `{roomId}` |
| GET | `/api/rooms` | – | `[{roomId,name,host,playerCount,mode,state}]` (waiting 이면서 참가자 1명 이상인 방만 — 전원 퇴장 후 GC 유예 중인 빈 방은 제외) |
| GET | `/api/ranking` | – | `[{rank,userId,nickname,wins,draws,losses,points}]` |

**에러 규약**: REST 는 400 `{error:"사유"}` (잘못된 설정값, **선택 회차의 유효 문항 총합 < questionCount**),
401(미로그인), 404(없는 방/회차). 소켓은 `error` 이벤트 `{code, message}`.

**모의고사·오답노트**: `/api/practice` 는 `battle.js` 의 `buildQuestionSet({mode:'random'})` 을 그대로 쓴다(회차별 균등 배분).
`/api/practice/grade` 는 회차가 고정돼 있지 않으므로 **제출한 `answers` 의 키**로 문항 집합을 복원한다 —
모르는 문항 id 는 무시하고, 실존 문항이 0개면 400, 한 번에 최대 200문항까지 채점한다.
오답노트 판정은 **문항별 가장 최근 채점 결과**를 따른다: `wrong_ids` 에 있으면 오답, `question_ids` 에만 있으면 해제.
`question_ids` 가 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.

**치팅 방어**: `/api/rounds/:id` 와 `battle:questions` 페이로드에서 `accept`·`sampleAnswer`·`validator`·`display`
를 **반드시 제거**한다. `fields` 는 `{label}` 만 남긴다. 채점은 서버에서만 한다.
`bodyText`(지문 평문) 는 정답 정보가 아니므로 `battle:questions` 에는 포함한다(결과 화면 AI 질문 복사용).
`/api/rounds/:id` 는 학습 모드 채점 응답의 `bodyTexts` 맵으로 채점 후에만 내보낸다. `sourceImages` 는 어느 쪽에도 보내지 않는다.
회차 id 는 **인메모리 화이트리스트**로 검사해 경로 순회를 차단한다.

## 소켓 이벤트 (전 이벤트 서버 권위, 클라이언트는 표시만)

| 이벤트 | 방향 | 페이로드 |
|---|---|---|
| `room:join` | C→S | `{roomId}` — waiting 상태에서만 허용 |
| `room:leave` | C→S | `{}` |
| `room:start` | C→S | `{}` — 방장 소켓 + 2인 이상 검증 |
| `room:invite` | S→C | `{roomId, name, fromUserId, fromNickname, settings:{mode, roundIds, questionCount, timeLimitS}}` — `POST /api/rooms` 의 `inviteUserIds` 중 **지금 소켓이 붙어 있는** 대상에게 1회 배달. 상태를 만들지 않으며(보관·재시도 없음) 받은 쪽이 `room:join` 을 보내야 참가다 |
| `room:state` | S→C | `{state, players:[{userId,nickname,connected}], settings}` — 방 상태 변경 시 브로드캐스트 |
| `battle:questions` | S→C | `{questions[](정답·sampleAnswer 제외), deadlineInfo}` — countdown 종료 시 |
| `battle:answer` | C→S | `{questionId, fieldIndex, value}` — 서버가 실시간 보관(제출 아님) |
| `battle:progress` | S→C | `{userId, answeredCount}` — 400ms 디바운스 브로드캐스트, **정오 비공개** |
| `battle:submit` | C→S | `{}` — **명시적·비가역**. 서버가 submitted_at 기록, 이후 `battle:answer` 거부 |
| `battle:tick` | S→C | `{remainingMs}` — 10초 주기 재동기 |
| `battle:resync` | S→C | `{state, questions, myAnswers, remainingMs, players[]}` — 재접속 시 **스냅샷 1회** (이벤트 재생 금지) |
| `battle:finished` | S→C | `{results:[{userId,correctCount,score,submittedAt}], winnerUserId(무승부 null), details[](문항별 정오·display)}` |

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
