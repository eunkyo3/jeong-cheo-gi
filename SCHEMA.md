# 동결 스키마 (Phase 0) — 변경 금지

프로젝트 루트: `D:\sw_knight\jpk-battle`
계획: `D:\sw_knight\.omc\plans\jeongbo-quiz-webapp-plan.md`
스펙: `D:\sw_knight\.omc\specs\deep-interview-jeongbo-quiz-webapp.md`

## 회차 목록 (총 21회차 — 전부 별도 페이지)

| round | postId | round | postId | round | postId |
|---|---|---|---|---|---|
| 2020-1 | 196 | 2022-1 | 271 | 2024-1 | 476 |
| 2020-2 | 195 | 2022-2 | 423 | 2024-2 | 483 |
| 2020-3 | 194 | 2022-3 | 424 | 2024-3 | 495 |
| 2020-4 | 192 | 2023-1 | 372 | 2025-1 | 540 |
| 2021-1 | 191 | 2023-2 | 420 | 2025-2 | 554 |
| 2021-2 | 210 | 2023-3 | 453 | 2025-3 | 558 |
| 2021-3 | 217 | | | 2026-1 | 561 |
| | | | | 2026-2 | 562 |

> 계획서의 "2020년 3·4회는 한 페이지" 가정은 **오류**였다. 실제로는 194/192 별도 페이지다.
> `https://chobopark.tistory.com/561` 은 목차 겸 **2026년 1회 본문** 페이지다.

수집 완료: `data/raw/{round}/` 에 `page.html`, `article.html`, `page.txt`, `imgNN.png|jpg`, `images.json`.
전 21회차 수집 성공, 이미지 실패 0건 (`data/raw/scrape-report.json`).

## 회차 JSON 스키마 (`data/rounds/{round}.json`)

```jsonc
{
  "round": "2026-2",                              // 파일명과 일치
  "title": "2026년 2회",
  "sourceUrl": "https://chobopark.tistory.com/562",
  "questions": [{
    "id": "2026-2#1",                             // "{round}#{num}" — 전역 유일
    "num": 1,                                     // 원본(블로그) 문항 번호 보존. 엄격 오름차순, 제외 문항 자리는 비워 둔다(재번호 금지)
    "prompt": "다음은 ... 쓰시오.",                 // 문항 제목(발문). HTML 인라인 태그 허용
    "bodyHtml": "<div class=\"desc-box\">…</div>", // 지문 본문. 표=table.tbl, 코드=pre.code
    "bodyText": "…",                              // AI 질문 복사용. 표→마크다운 표, 코드→``` 펜스
    "sourceImages": ["raw/2026-2/img00.png"],      // 판독 근거 이미지(없으면 []). data/ 기준 상대경로
    "answerMode": "ordered",                      // "ordered" | "unordered"
    "fields": [{
      "label": "답",
      "accept": ["ㄱ", "동치분할"],                 // validator 있으면 반드시 []
      "normalize": "default",                     // "default" | "keepSpace" | "sql"
      "validator": null,                          // 또는 {"type":"ip-in-subnet","cidr":"…","exclude":[…]}
      "sampleAnswer": "ㄱ"                         // 필수. 기계 판독 가능한 예시 정답
    }],
    "display": "ㄱ. 동치분할 (Equivalence Partitioning)"  // 오답 시 보여줄 사람용 정답 전체 표기
  }]
}
```

### 필드 규칙 (강제)

- `normalize`
  - `default` — NFC → 소문자 → 전공백 제거 → 후행 구두점 제거. **기본값.**
  - `keepSpace` — NFC → trim. 내부 공백·대소문자 유지. **코드 출력 문항 전용.**
    대소문자 무시를 유지하려면 accept 에 대/소문자 변형을 모두 나열한다.
  - `sql` — NFC → 소문자 → 연속 공백 1칸 압축 → 후행 `;`/`.`/공백 제거.
- `answerMode`
  - `ordered` — 입력 필드 i ↔ `fields[i]` 매칭. **기본.**
  - `unordered` — "N가지를 쓰시오" 유형. 입력값 집합 ↔ accept 집합 최대 이분 매칭.
    매칭 전 **정규화된 입력값 중복 제거**. 중복 제거 후 입력 수 < 필드 수면 오답.
    **unordered 문항은 전 필드가 동일 `normalize` 여야 한다** (validate 가 강제).
- `validator` 배타 규칙 — validator 가 있으면 `accept` 는 `[]`, normalize 미적용(원문 trim만).
- **validator 카탈로그** (현재 2종):
  - `ip-in-subnet` — `{"type":"ip-in-subnet","cidr":"192.168.35.0/24","exclude":["192.168.35.3"]}`.
    CIDR 내 유효 호스트. 네트워크·브로드캐스트·exclude 는 오답.
  - `keywords` — `{"type":"keywords","all":["무결성"],"any":["제약","규칙"],"minAny":1}`.
    **서술형("…을 서술하시오") 전용.** 입력·키워드 모두 default 정규화 후 `all` 전부 포함 + `any` 중 `minAny` 개 이상 포함이면 정답.
    `minAny` 생략 시 `any` 가 있으면 1. `all`/`any` 둘 다 비면 validate 가 거부한다.
    `sampleAnswer` 는 키워드를 모두 담은 짧은 구, `display` 는 원문 모범답안 전체.
    등재일 2026-08-29 (2020년 회차 서술형 8문항 근거, 원칙 3 절차 이행: grader 함수 + 단위 테스트 6건 + 전 회차 validate 통과).
- 문항 정답 = **모든 필드 정답** (부분점수 없음).
- 점수 = `Math.round(correctCount / totalCount * 100)`.

### validator 카탈로그 확장 절차 (원칙 3 — 이 절차 밖의 grader 수정 금지)

1. `server/grader.js` 의 `VALIDATORS` 에 타입 함수 추가
2. `tests/grader.test.mjs` 에 해당 타입 단위 테스트 추가
3. `npm run validate` 전 회차 재실행 통과

새 계산형이 `accept` 열거로 표현 가능하면 **열거를 우선**한다.
열거 불가 + 절차 부담 과다 → 해당 문항은 `data/excluded.md` 처리.

## 채점 엔진 API (`server/grader.js`, CommonJS)

```js
const { gradeQuestion, gradeSet, normalizeValue, fieldAccepts, runValidator,
        ipToInt, NORMALIZE_MODES, VALIDATOR_TYPES } = require('./grader.js');

gradeQuestion(question, answers /* string[] */)
  // → { questionId, correct, fieldResults: [{fieldIndex,label,given,correct}], display }

gradeSet(questions, answersMap /* {questionId: string[]} */)
  // → { correctCount, totalCount, score, details[] }
```

**grader.js 는 순수 함수만 포함한다. I/O 금지.**

## SQLite 스키마

```sql
users(id PK, nickname UNIQUE, password_hash, created_at, session_version INTEGER NOT NULL DEFAULT 0)
matches(id PK, room_name, mode, round_ids TEXT, question_ids TEXT,
        time_limit_s, started_at, finished_at, winner_user_id)
match_players(match_id FK→matches(id) ON DELETE CASCADE,
              user_id  FK→users(id)   ON DELETE CASCADE,
              correct_count, submitted_at, answers JSON,
              PRIMARY KEY (match_id, user_id))
study_results(id PK, user_id FK→users(id) ON DELETE CASCADE, round, score, taken_at,
              question_ids TEXT NULL, wrong_ids TEXT NULL, match_id INTEGER NULL)
```

**외래 키는 선언만이 아니라 실제로 걸려 있다.** `PRAGMA foreign_keys = ON` 과 위 `REFERENCES` 절이
짝을 이루므로, 계정을 지우면 그 사람의 `match_players`·`study_results` 행이 함께 사라진다
(매치 자체는 남는다 — 다른 참가자의 기록이기도 하기 때문이다).
`study_results.match_id` 만 **FK 가 아닌 느슨한 참조**다: `battle` 행에서만 값이 있고 NULL 이 정상 상태이며,
매치를 지운다고 학습 기록까지 지워서는 안 되기 때문이다(아래 `match_id` 설명 참조).

### 인덱스

| 인덱스 | 대상 | 쓰이는 곳 |
|---|---|---|
| `idx_mp_user` | `match_players(user_id)` | 내가 참가한 매치 찾기 |
| `idx_mp_match` | `match_players(match_id)` | 매치별 참가자 조회 |
| `idx_sr_user` | `study_results(user_id)` | 사용자별 학습 기록 |
| `idx_sr_user_id` | `study_results(user_id, id DESC)` | `/api/me/*` 의 최신순 조회(정렬 없이 인덱스만 읽는다) |

`users.nickname` 의 UNIQUE 와 `match_players` 의 복합 PK 는 SQLite 가 자동으로 인덱스를 만든다.

### 스키마 버전과 마이그레이션 (`PRAGMA user_version`)

스키마 변경은 **`server/db.js` 의 `MIGRATIONS` 배열에만** 적는다. 기동할 때 `PRAGMA user_version` 을 읽어
밀린 것만 순서대로, **각각 트랜잭션 안에서** 돌린다. 새로 만든 DB 는 최종 모양(`SCHEMA_SQL`)으로 곧바로
생기고 번호만 끝으로 찍히므로, "새 DB" 와 "끝까지 마이그레이션한 옛 DB" 의 스키마는 **완전히 같다**
(`tests/db-adapter.test.mjs` 가 두 파일의 컬럼·FK·인덱스를 비교해 못박는다).

| 버전 | 내용 |
|---|---|
| 1 | `study_results` 에 `question_ids` / `wrong_ids` / `match_id` 추가 |
| 2 | `users.session_version` 추가 (기본 0) |
| 3 | `idx_sr_user_id(user_id, id DESC)` 생성 |
| 4 | `match_players` · `study_results` 를 실제 FK(`ON DELETE CASCADE`) 로 재작성 |

**밀린 마이그레이션이 하나라도 있으면 손대기 전에 파일을 통째로 복사한다** —
`data/app.db.bak-<YYYYMMDD-HHMMSS>` (JSON 어댑터는 `app.json.bak-…`). 최근 **5개**만 남기고 지운다.
마이그레이션이 중간에 실패하면 트랜잭션이 되감기고 기동이 중단되므로, 그 백업으로 되돌리면 된다.
4번은 SQLite 규약대로 **트랜잭션 밖에서 `foreign_keys` 를 끄고** 새 테이블 생성 → 복사 → 삭제 → 이름 변경 순으로 진행한다.

각 마이그레이션의 `up()` 은 **여러 번 돌아도 안전하게** 쓴다(컬럼·인덱스·FK 존재를 직접 확인한 뒤에만 손댄다).
`user_version` 이 0 인 채 이미 최신 모양인 DB 도 그래서 문제없이 통과한다.

JSON 어댑터는 파일 안의 `schemaVersion` 필드로 같은 눈금을 쓴다. 인덱스(3)와 FK(4)는 sqlite 전용이라
JSON 쪽에서는 대응 동작이 없다. JSON 어댑터는 파일을 읽을 때 `seq` 를 **깊은 병합**하고
각 테이블의 최대 id 로 끌어올린다(하위 키가 빠져 id 가 `NaN` 이 되거나 id 가 겹치던 문제를 막는다).
쓰기는 200ms 디바운스로 묶이며 `flushSync()` / `close()` / 프로세스 종료가 반드시 흘려보낸다.

`study_results.round` 는 다음 넷 중 하나다 — **회차 id**(`2026-2` 등), `practice`(랜덤 모의고사),
`wrong`(오답노트), `battle`(대전). 집계 경로(`/api/me/history`, `/api/me/wrong`)는 이 값을 해석하지 않고
그대로 집합 키로 쓰므로 네 종류가 같은 규칙으로 합류한다.
`battle` 행은 `db.saveMatch` 가 매치·참가자와 **같은 트랜잭션(json 어댑터는 같은 flush)** 에서
참가자 1명당 1행씩 쓰며(`match_id` 도 그 자리에서 박는다), `taken_at` 은 기록 시각이 아니라 **매치 종료 시각(`matches.finished_at`)** 이다
(소급 스크립트 `scripts/backfill-battle-notes.mjs` 가 같은 값으로 중복을 판별해 멱등성을 얻는다).
`question_ids`(출제 문항 전체) / `wrong_ids`(그중 틀린 문항)는 **JSON 배열 문자열이며 NULL 을 허용**한다 —
컬럼 도입 이전 기록은 NULL 로 남고, 그런 행은 문항 단위 판정(오답노트)에서 제외된다.
`match_id` 는 **`battle` 행에서만** 값이 있는 `matches.id` 참조다(그 밖의 행은 NULL). 오답노트를 **대전 단위**로 묶는
유일한 연결고리이며(`GET /api/me/wrong/summary` 의 `byBattle`, `GET /api/me/wrong?match=`), 값이 NULL 인 예전
대전 행은 대전별 보기에서만 빠지고 회차별 집계에는 그대로 든다 — `scripts/backfill-battle-notes.mjs` 가
(user, taken_at=finished_at, question_ids 동일) 로 매치를 찾아 UPDATE 로 소급해 채운다(멱등).
이 세 컬럼은 마이그레이션 **1번**이 없는 것만 골라 `ALTER TABLE ADD COLUMN` 으로 붙인다(기존 DB 무중단).

`users.session_version` 은 **세션 일괄 폐기용 세대 번호**다. 세션 쿠키에 같은 값(`sv`)이 실려 나가고,
`auth.attachUser` 가 두 값이 다르면 비로그인으로 본다. `db.bumpSessionVersion(userId)` 를 부르면
그 사용자에게 이미 나간 쿠키가 전부 무효가 된다. `sv` 가 없는 예전 쿠키는 0 으로 읽으므로 배포만으로 로그아웃되지 않는다.

`users.password_hash` 는 `scrypt$<salt base64>$<key base64>` (N=16384, r=8, p=1, 32바이트) 다.
예전 bcrypt 해시(`$2a$…`)도 그대로 검증하며, **로그인에 성공한 그 자리에서** scrypt 로 다시 저장한다
(`db.updatePasswordHash`). 두 형식이 한 컬럼에 섞여 있는 것이 정상 상태다.

승자 판정 체인: ① 정답 수 → ② 제출 시각(이탈자는 이탈 시각 = 즉시 제출 간주, 끊긴 채 미제출인 유저는 deadline) → ③ 마지막 `battle:answer` 시각
(입력 전무 시 deadline) → ④ 전부 동률이면 **무승부**(`winner_user_id` NULL).

랭킹: 매치당 1등 +3, 그 외 참가 +1, 무승부 매치는 전원 +1(1등 없음).
표시: 순위·닉네임·승·무·패(=참가−승−무)·승점. 정렬: 승점 → 승수 → 닉네임.

## 해설 JSON 스키마 (`data/explanations/{round}.json`)

문항 해설은 **회차 파일과 완전히 분리된 별도 자산**이다. 감사 완료된 `data/rounds/*.json` 은 건드리지 않는다.

```json
{
  "round": "2026-2",
  "explanations": {
    "2026-2#1": "<p>정답은 <mark>내용 결합도</mark>입니다.</p><p>…</p>",
    "2026-2#2": "…"
  }
}
```

| 규칙 | 내용 |
|---|---|
| 파일 1개 = 회차 1개 | 파일명은 `{round}.json`, 최상위 `round` 필드가 **파일명과 일치**해야 한다 |
| 커버리지 | 그 회차의 **모든 문항 id 를 정확히** 커버한다 — 누락·잉여 모두 실패 |
| 값 | 문자열 HTML. 길이 **150~1500자**(태그 포함) |
| 허용 태그 | `p b mark br ul ol li code pre` **만**. `<br/>` `<br />` 도 허용, 대소문자 무시 |
| 속성 | **전면 금지** (`<p class="x">` 는 실패) |
| 이스케이프 | 코드·수식의 `<` `>` `&` 는 엔티티(`&lt;` `&gt;` `&amp;`)로 쓴다 — 태그가 아닌 날 `<` 는 실패 |
| 금지 | `<script`(대소문자 무시), `javascript:` 는 즉시 실패 |
| 인코딩 | UTF-8 |

검증: `npm run validate:explain` (전체 모드 — 전 회차 파일 필수) /
`node scripts/validate-explanations.mjs --partial` (집필 중 체크포인트 — 존재하는 파일만).
`npm run preflight` 의 ⑥단계가 전체 모드로 게이트한다(해설 파일이 0개면 건너뛴다).

**노출 시점**: 서버는 기동 시 이 파일들을 읽어 문항 객체에 `explanationHtml` 로 붙인다(내부 전용).
클라이언트에는 **채점이 끝난 뒤에만** 나간다 — 아래 "클라이언트에 절대 전송 금지" 참조.

작성 지침은 `docs/explanations/_TEMPLATE.md`, 진행 현황은 `docs/explanations/PROGRESS.md`.
`data/explanations/` 에는 회차 JSON 만 둔다 — 사이드카 디렉터리에 문서를 섞지 않는다.

## 문항 유형 JSON 스키마 (`data/types/{round}.json`)

문항 분류(코드 / SQL / 이론)는 **회차 파일과 완전히 분리된 별도 자산**이다.
감사 완료된 `data/rounds/*.json` 은 건드리지 않는다(해설과 같은 원칙).

```json
{
  "round": "2026-2",
  "types": {
    "2026-2#1": "theory",
    "2026-2#2": "code",
    "2026-2#12": "sql"
  }
}
```

| 규칙 | 내용 |
|---|---|
| 파일 1개 = 회차 1개 | 파일명은 `{round}.json`, 최상위 `round` 필드가 **파일명과 일치**해야 한다 |
| 커버리지 | 그 회차의 **모든 문항 id 를 정확히** 커버한다 — 누락·잉여 모두 실패 |
| 값 | `code` \| `sql` \| `theory` **셋뿐**. 문자열이고 대소문자를 구분한다(`CODE` 는 실패) |
| 인코딩 | UTF-8 |

### 분류 기준 (동결)

| 유형 | 기준 |
|---|---|
| `code` | 프로그램 코드(C/Java/Python 등)를 읽고 출력·동작·빈칸을 푸는 문제. 코드가 지문에 있고 **그 코드를 해석해야** 답이 나오면 code |
| `sql` | SQL 문을 읽거나 작성하는 문제(실행 결과, 빈칸 채우기, 문법). **SQL 용어만 묻는 개념 문제**(예: "DDL 3가지를 쓰시오")**는 theory** |
| `theory` | 그 외 전부. 용어·개념·서술형, 그리고 **표/계산 문제**(서브넷·스케줄링·정규화·결합도 등)**도 theory**(코드 해석이 아니므로) |

애매하면 **"이 문제를 풀려면 코드를 한 줄씩 따라가야 하는가?"** 로 판단한다 — 예/아니오 → `code`/`theory`.
의사코드·순서도만 있고 프로그래밍 언어가 아니면 `theory`.

검증: `npm run validate:types` (전체 모드 — 전 회차 파일 필수) /
`node scripts/validate-types.mjs --partial` (분류 중 체크포인트 — 존재하는 파일만).
`npm run preflight` 의 ⑦단계가 전체 모드로 게이트한다(분류 파일이 0개면 건너뛴다).

**노출 시점**: 서버는 기동 시 이 파일들을 읽어 문항 객체에 `type` 으로 붙인다.
해설과 달리 **정답 정보가 아니므로** `publicQuestion()` 화이트리스트에 올라가 **채점 전에도** 클라이언트로 나간다
(문항 카드의 유형 뱃지, 유형 필터에 필요하다).
분류 파일이 없거나 문항이 빠져 있어도 서버는 기동한다 — 그 문항은 **기본값 `theory`** 로 두고 경고만 남긴다.
따라서 `q.type` 은 언제나 세 값 중 하나다.

## 문항 언어 JSON 스키마 (`data/langs/{round}.json`)

**코드 유형 문항**의 프로그래밍 언어(C / Java / Python) 분류다. 유형과 **똑같은 오버레이 패턴**으로,
회차 파일과 완전히 분리된 별도 자산이다 — `data/rounds/*.json` 은 건드리지 않는다.

```json
{
  "round": "2026-2",
  "langs": {
    "2026-2#2": "c",
    "2026-2#5": "python",
    "2026-2#11": "java"
  }
}
```

| 규칙 | 내용 |
|---|---|
| 파일 1개 = 회차 1개 | 파일명은 `{round}.json`, 최상위 `round` 필드가 **파일명과 일치**해야 한다 |
| 커버리지 | 그 회차의 **유형이 `code` 인 문항 id 를 정확히** 커버한다 — 누락·잉여 모두 실패. **비코드 문항 id 는 잉여로 실패**한다 |
| 값 | `c` \| `java` \| `python` **셋뿐**. 문자열이고 대소문자를 구분한다(`Java` 는 실패) |
| 인코딩 | UTF-8 |

표기는 화면에서 **C / Java / Python**, 데이터에서는 언제나 소문자다.

### 분류 기준 (동결)

근거가 강한 것부터 본다 — `scripts/classify-langs.mjs` 가 이 순서를 그대로 구현한다.

| 순위 | 근거 |
|---|---|
| 1 | `bodyText` 의 마크다운 펜스 태그(```` ```c ```` / ```` ```java ```` / ```` ```python ````) — 스크랩 단계에서 원문 코드 블록에 붙은 표시라 사실상 정답이다 |
| 2 | 발문(`prompt`)의 언어 이름 — `java\|자바`, `python\|파이썬`, `C언어\|C 언어\|C\|C++` |
| 3 | 코드 본문의 문법 지문 — `System.out`·`public static void`(java), `print(`·`def `·`self`(python), `#include`·`printf`·`scanf`(c) |

근거가 서로 어긋나면 위 순위가 이긴다(생성기가 불일치 목록을 찍는다). 손으로 못박아야 하는 문항은
`classify-langs.mjs` 의 `OVERRIDES` 에 적는다 — 지금은 `2025-1#15`(`int Main(...)` 문장 커버리지) 하나뿐이다.

생성: `node scripts/classify-langs.mjs`(미리보기) / `--write`(파일 생성) / `--verbose`(문항별 근거).

검증: `npm run validate:langs` (전체 모드 — 전 회차 파일 필수) /
`node scripts/validate-langs.mjs --partial` (분류 중 체크포인트 — 존재하는 파일만).
`npm run preflight` 의 ⑧단계가 전체 모드로 게이트한다(언어 파일이 0개면 건너뛴다).

**노출 시점**: 서버는 기동 시(유형을 붙인 **뒤에**) 이 파일들을 읽어 문항 객체에 `lang` 으로 붙인다.
유형과 마찬가지로 **정답 정보가 아니므로** `publicQuestion()` 화이트리스트에 올라가 **채점 전에도** 나간다
(언어 뱃지, 언어 필터에 필요하다).

유형과 다른 점은 **기본값이 없다**는 것이다. 비코드 문항·미분류 문항의 `lang` 은 `null` 이고,
그런 문항은 언어 필터에서 빠질 뿐이다. 언어 파일이 없거나 깨져도 서버는 그냥 뜬다(경고만 남긴다).
따라서 `q.lang` 은 `c` \| `java` \| `python` \| `null` 넷 중 하나다.

## 문항 id 규칙 (동결) 과 지문 서명 (`data/.qfingerprint.json`)

**문항 id 불변 · 삭제 대신 tombstone · 추가는 append only.**

사이드카 3종(해설·유형·언어)은 전부 문항 id 로 회차 파일과 맞물리고, 검증기 3종은 **id 집합**만
대조한다. 그래서 회차 중간 문항을 지우고 뒤 문항을 한 칸씩 당기면(재번호) id 집합은 그대로인데
사이드카가 전부 다른 문항을 가리킨다 — **어느 검증기도 실패하지 않는 유일한 무성 오염**이다.

- 한 번 발행한 `id`(=`{round}#{num}`)는 다른 문항에 재사용하지 않는다.
- 문항을 빼야 하면 뒤를 당기지 않고 그 번호를 비워 둔다(`data/excluded.md` 에 사유 기록).
- 문항 추가는 뒤에 붙이는 것만 허용한다.

```json
{
  "2026-2#1": "3f2c…(sha1 40자)",
  "2026-2#2": "9a71…"
}
```

| 규칙 | 내용 |
|---|---|
| 파일 | `data/.qfingerprint.json` — 최상위가 `{ "<문항 id>": "<sha1 hex 40자>" }` 평면 객체 |
| 커버리지 | 로드되는 **전 문항**을 정확히 덮는다 — 누락·잉여 모두 실패 |
| 서명 입력 | 정규화한 `prompt` 앞 200자 + `"|"` + `fields.length` + `"|"` + 정규화한 본문(`bodyText`, 없으면 `bodyHtml`) 앞 200자 |
| 정규화 | NFC → HTML 태그 제거 → 연속 공백 1칸 → trim |
| 커밋 | **커밋 대상이다.** `.gitignore` 에 넣지 않는다 |
| 갱신 | `node scripts/fingerprint-questions.mjs --write` (문항을 정당하게 고친 뒤에만) |

검증: `npm run validate:fingerprint` · `npm run preflight` 의 ⑨단계 · `tests/fingerprint.test.mjs`.
파일이 없으면 **건너뛰지 않고 FAIL** 한다. 본문까지 서명에 넣는 이유는 `prompt` 만으로는 정형 발문
("다음 설명에서 괄호 안에 들어갈 알맞은 용어를 쓰시오.")끼리 서명이 겹쳐 한 칸 밀림을 놓칠 수 있어서다.

## 클라이언트에 절대 전송 금지

`accept`, `sampleAnswer`, `validator`, `display`(채점 전), `explanationHtml` — 서버에서 반드시 제거하고 내보낸다.

`explanationHtml` 은 정답을 그대로 서술하므로 **채점 전 노출은 정답 유출과 같다.**
`rounds.publicQuestion()` · `battle.publicQuestion()` 은 둘 다 **화이트리스트 방식**이라 문항 객체에
어떤 필드가 새로 붙어도 자동으로 걸러진다. 해설은 채점 응답의 `explanations{}` 맵과
`battle:finished` 페이로드로만 나간다(PROTOCOL.md).

화이트리스트 **구현은 `server/qtypes.js` 의 `publicQuestion(q, opts)` 하나뿐이다.**
`rounds.publicQuestion()` · `battle.publicQuestion()` 은 그 한 함수를 부르는 얇은 껍데기이고,
두 호출부의 차이는 옵션 두 개로만 갈린다 — 금지 필드 제거 규칙은 완전히 공통이다.

| 필드 | 학습 REST (`rounds`) | 대전 (`battle`) | 이유 |
|---|---|---|---|
| `id`·`num`·`prompt`·`bodyHtml`·`type`·`lang`·`fields[].label` | 나간다 | 나간다 | 문항 표시·유형/언어 뱃지·필터 |
| `bodyText` | **안 나간다** | 나간다 | 학습 모드는 채점 응답의 `bodyTexts` 맵으로만 (PROTOCOL.md "채점 전 비노출") |
| `answerMode` | 안 나간다 | 나간다 | 대전 클라이언트 전용 |
| 그 밖의 모든 필드 | 안 나간다 | 안 나간다 | 화이트리스트에 없으면 구조적으로 실리지 않는다 |
