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
users(id PK, nickname UNIQUE, password_hash, created_at)
matches(id PK, room_name, mode, round_ids TEXT, question_ids TEXT,
        time_limit_s, started_at, finished_at, winner_user_id)
match_players(match_id FK, user_id FK, correct_count, submitted_at, answers JSON)
study_results(id PK, user_id FK, round, score, taken_at,
              question_ids TEXT NULL, wrong_ids TEXT NULL)
```

`study_results.round` 는 다음 넷 중 하나다 — **회차 id**(`2026-2` 등), `practice`(랜덤 모의고사),
`wrong`(오답노트), `battle`(대전). 집계 경로(`/api/me/history`, `/api/me/wrong`)는 이 값을 해석하지 않고
그대로 집합 키로 쓰므로 네 종류가 같은 규칙으로 합류한다.
`battle` 행은 `db.saveMatch` 가 매치·참가자와 **같은 트랜잭션(json 어댑터는 같은 flush)** 에서
참가자 1명당 1행씩 쓰며, `taken_at` 은 기록 시각이 아니라 **매치 종료 시각(`matches.finished_at`)** 이다
(소급 스크립트 `scripts/backfill-battle-notes.mjs` 가 같은 값으로 중복을 판별해 멱등성을 얻는다).
`question_ids`(출제 문항 전체) / `wrong_ids`(그중 틀린 문항)는 **JSON 배열 문자열이며 NULL 을 허용**한다 —
컬럼 도입 이전 기록은 NULL 로 남고, 그런 행은 문항 단위 판정(오답노트)에서 제외된다.
sqlite 어댑터는 기동 시 `PRAGMA table_info` 로 두 컬럼이 없으면 `ALTER TABLE ADD COLUMN` 한다(기존 DB 무중단 마이그레이션).

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

작성 지침은 `data/explanations/_TEMPLATE.md`, 진행 현황은 `data/explanations/PROGRESS.md`.

## 클라이언트에 절대 전송 금지

`accept`, `sampleAnswer`, `validator`, `display`(채점 전), `explanationHtml` — 서버에서 반드시 제거하고 내보낸다.

`explanationHtml` 은 정답을 그대로 서술하므로 **채점 전 노출은 정답 유출과 같다.**
`rounds.publicQuestion()` · `battle.publicQuestion()` 은 둘 다 **화이트리스트 방식**이라 문항 객체에
어떤 필드가 새로 붙어도 자동으로 걸러진다. 해설은 채점 응답의 `explanations{}` 맵과
`battle:finished` 페이로드로만 나간다(PROTOCOL.md).
