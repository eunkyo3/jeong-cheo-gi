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

`study_results.round` 는 회차 id 이거나 학습 집합 키(`practice` = 랜덤 모의고사, `wrong` = 오답노트)다.
`question_ids`(출제 문항 전체) / `wrong_ids`(그중 틀린 문항)는 **JSON 배열 문자열이며 NULL 을 허용**한다 —
컬럼 도입 이전 기록은 NULL 로 남고, 그런 행은 문항 단위 판정(오답노트)에서 제외된다.
sqlite 어댑터는 기동 시 `PRAGMA table_info` 로 두 컬럼이 없으면 `ALTER TABLE ADD COLUMN` 한다(기존 DB 무중단 마이그레이션).

승자 판정 체인: ① 정답 수 → ② 제출 시각(이탈자는 이탈 시각 = 즉시 제출 간주, 끊긴 채 미제출인 유저는 deadline) → ③ 마지막 `battle:answer` 시각
(입력 전무 시 deadline) → ④ 전부 동률이면 **무승부**(`winner_user_id` NULL).

랭킹: 매치당 1등 +3, 그 외 참가 +1, 무승부 매치는 전원 +1(1등 없음).
표시: 순위·닉네임·승·무·패(=참가−승−무)·승점. 정렬: 승점 → 승수 → 닉네임.

## 클라이언트에 절대 전송 금지

`accept`, `sampleAnswer`, `validator`, `display`(채점 전) — 서버에서 반드시 제거하고 내보낸다.
