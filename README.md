# 정처기 배틀 — 정보처리기사 실기 기출 학습·대전 웹앱

내 PC에서 Node.js 서버 하나를 띄우고, 같은 네트워크(또는 Tailscale)의 친구들이 브라우저로 접속해
정보처리기사 실기 복원 기출을 **혼자 학습**하거나 **실시간으로 대전**하는 웹앱입니다.

- 학습 모드: 회차 선택 → 풀이 → 즉시 채점(100점 만점) → 틀린 문제마다 **AI 질문 프롬프트 복사**
- 대전 모드: 닉네임+비밀번호로 로그인 → 방 생성/참여 → 동시 시작 → 실시간 진행 현황 → 승자 판정
- 랭킹: 대전 전적(승/무/패/승점) 기준 순위
- 유형별 학습: 문항을 **코드 · SQL · 이론**으로 나눠 원하는 유형만 골라 풀기 (학습·모의고사·오답노트·대전 전부)
- 언어별 학습: 코드 문항 139개를 **C · Java · Python** 으로 나눠 원하는 언어만 골라 풀기 (학습·모의고사·오답노트·대전 전부)
- 해설: **420문항 전 문항 해설** — 채점 후에만 문항별 "해설 보기" (비전공자 눈높이, 핵심 강조 표시). 단 **오답노트에서는 이미 채점받은 문항이므로 채점 전에도 정답·해설을 바로 펼쳐 볼 수 있습니다**
- 오답노트 허브(`/wrong.html`): 오답을 **회차별 / 대전별(방 이름)** 로 모아 보고, 그 대전에서 뭘 틀렸는지 확인한 뒤 그 문항만 다시 풀기
- 모든 문항 카드 우상단에 **몇 년도 몇 회차 몇 번** 문제인지 표기 (학습·모의고사·오답노트·대전 풀이·대전 결과)
- 섞인 세트(모의고사·오답노트·랜덤 대전)는 문항 번호를 **1, 2, 3… 순번**으로, 원본 번호는 회차 뱃지에
- 제출 전 **답한 문항 n/N** 표시와 빈칸 확인(취소하면 첫 빈칸으로 이동) · 메인 로그인은 Enter 로 · 채점 후 점수 박스는 스크롤하면 한 줄로
- **보기 탭 입력**: `[보기]`가 있는 문항은 보기 항목을 탭하면 답 칸에 채워짐("기호로 쓰시오"면 기호만) — 학습·대전 동일
- 학습 하단 미니바(답한 n/N · 다음 빈칸으로 · 제출), 타이머는 접힌 상태 기본
- 대전: 방 만들기 연도별 접기 + "최근 3회차" 프리셋, 대기실 회차 요약, **결과 화면에서 상대 답안 ✓/✗ 확인**(종료 후에만 전송)
- 내비 한 스타일(현재 페이지 밑줄, 320px 한 줄), 랭킹 모바일 3열 + 행 탭으로 승·무·패 펼침
- 불합격이면 **"틀린 N문항 해설 보기 →"** 로 바로 이동, 키보드 포커스 링(`:focus-visible`), 이력 날짜는 "오늘 14:00 / 어제 / 3일 전", 본문 회색 글자 대비 AA 충족
- **다크 모드**: 별도 설정 없이 기기·브라우저의 밝기 설정(`prefers-color-scheme`)을 따라갑니다. 애니메이션 최소화 설정(`prefers-reduced-motion`)도 존중합니다

### 학습 이력 · 오답노트 · 랜덤 모의고사

로그인한 채로 채점하면 회차별 응시 횟수·최고점·최근 점수가 쌓이고, **틀린 문항이 자동으로 오답노트에 모입니다**
(나중에 그 문항을 맞히면 노트에서 빠집니다). 여러 회차를 섞어 5~60문항을 뽑는 **랜덤 모의고사**도 학습 모드에서 바로 풀 수 있습니다.
오답노트와 모의고사 결과 역시 이력에 함께 기록됩니다. 대전 결과도 방 이름과 함께 기록되어, 오답노트 허브의 **대전별** 탭에서
"이 대전에서 틀린 문항"을 펼쳐 보고 그것만 다시 풀 수 있습니다(그 뒤 맞힌 문항은 "이후 맞힘"으로 표시).

## 실행 화면

| 메인 — 학습 이력 · 오답노트 · 랜덤 모의고사 | 학습 모드 — 채점 결과 (타이머·오답 카드) |
|---|---|
| ![메인](docs/screenshots/01-index.png) | ![채점 결과](docs/screenshots/03-study-graded.png) |

| 오답 카드 — AI 질문 복사 · 이의 제기 | 대전 로비 — 방 코드 참여 · 랜덤 회차 전체 선택 |
|---|---|
| ![오답 카드](docs/screenshots/04-study-wrong-card.png) | ![대전 로비](docs/screenshots/05-battle-lobby.png) |

| 대기실 — 방 코드 공유 | 대전 진행 — 남은 시간 · 실시간 진행 현황 |
|---|---|
| ![대기실](docs/screenshots/06-waiting-room.png) | ![대전 진행](docs/screenshots/07-battle-playing.png) |

| 대전 결과 — 승자 판정 · 문항별 채점 | 랭킹 — 승/무/패/승점 |
|---|---|
| ![대전 결과](docs/screenshots/08-result.png) | ![랭킹](docs/screenshots/09-ranking.png) |

| 대전 중 플로팅 현황 — 스크롤해도 타이머·진행 확인 | 제출 후 채점 현황 — 제출자끼리 문항별 정오 공유 |
|---|---|
| ![플로팅 현황](docs/screenshots/12-float-panel.png) | ![채점 현황](docs/screenshots/13-marks-shared.png) |

| 학습 — 채점 후 해설(비전공자용, 강조 표시) | 대전 결과 — 해설 보기/닫기 |
|---|---|
| ![학습 해설](docs/screenshots/14-study-explanation.png) | ![대전 해설](docs/screenshots/15-battle-explanation.png) |

| 학습 — 유형 필터(코드만 풀기) | 메인 — 회차별 유형 구성 · 모의고사 유형 선택 |
|---|---|
| ![유형 필터](docs/screenshots/16-study-type-filter.png) | ![유형 구성](docs/screenshots/17-index-type-counts.png) |

| 오답노트 허브 — 회차별 | 오답노트 허브 — 대전별(방 이름 · 상대 · 틀린 문항 펼침) |
|---|---|
| ![오답노트 회차별](docs/screenshots/19-wrong-hub-rounds.png) | ![오답노트 대전별](docs/screenshots/20-wrong-hub-battles.png) |

| 대전 풀이 — 문항마다 회차 뱃지 | 대전 오답 다시 풀기 — "이후 맞힘" 표시 |
|---|---|
| ![대전 회차 뱃지](docs/screenshots/18-battle-origin-badge.png) | ![대전 오답 재풀이](docs/screenshots/21-wrong-battle-resolve.png) |

| 메인 — 첫 화면에 "바로 풀어보기"·회차 선택, 계정은 맨 아래 | 채점 후 스크롤 — 점수 박스가 한 줄로 축소 |
|---|---|
| ![메인 재배치](docs/screenshots/23-index-anon-reordered.png) | ![점수 축소](docs/screenshots/25-score-compact.png) |

| 학습 — 보기 탭 입력 칩 + 하단 미니바 | 대전 결과 — 상대 답안 ✓/✗ |
|---|---|
| ![보기 칩](docs/screenshots/29-study-chips-bar.png) | ![상대 답안](docs/screenshots/32-result-opponent-answers.png) |

| 대전 — 방 만들기(연도 접기·프리셋) | 모바일 — 랭킹 3열 + 행 펼침 |
|---|---|
| ![방 만들기](docs/screenshots/30-battle-create-compact.png) | <img src="docs/screenshots/33-ranking-mobile.png" width="300"> |

| 코드 문항 — 원본의 탭·공백 혼용을 4칸 계단으로 정규화 (2020-1) | 학습 — 유형 "코드" 아래 언어 칩(C/Java/Python) + 언어 뱃지 |
|---|---|
| ![코드 들여쓰기](docs/screenshots/37-code-indent-2020.png) | ![언어 필터](docs/screenshots/38-study-lang-java.png) |

| 오답노트 — 채점 전 "정답·해설 보기" (이미 채점받은 문항만) | 오답노트 허브 — 대전별 탭에서 언어로 좁히기 |
|---|---|
| ![즉시 해설](docs/screenshots/40-wrong-peek.png) | ![허브 언어](docs/screenshots/44-wrong-hub-lang.png) |

| 메인 — 회차 카드에 언어별 문항 수, 모의고사 언어 선택 | 대전 — Python 방 (문항 전부 Python) |
|---|---|
| ![메인 언어](docs/screenshots/39-index-lang.png) | ![대전 Python](docs/screenshots/42-battle-python.png) |

| 모바일 — 오답노트 채점 | 모바일 — AI 질문 복사(클립보드 폴백 모달) |
|---|---|
| <img src="docs/screenshots/10-mobile-wrong-note.png" width="300"> | <img src="docs/screenshots/11-mobile-ai-copy-modal.png" width="300"> |

---

## 실행

**필요 환경: Node.js 22 이상** (`package.json` 의 `engines.node` 가 `>=22`). 20 에서도 서버는 뜨지만
개발용 명령 일부가 Node 22 의 테스트 러너 동작에 기대고 있습니다.

```bash
node -v          # v22.x 이상인지 확인
npm install
npm start
```

기동하면 콘솔에 접속 주소가 출력됩니다.

```
  로컬        http://localhost:3000
  LAN         http://192.168.0.12:3000
  Tailscale   http://100.x.y.z:3000
```

포트를 바꾸려면 `PORT=4000 npm start`. 포트가 이미 사용 중이면 명확한 에러를 내고 종료합니다.

### 최초 1회 — 방화벽 허용

다른 기기에서 접속하려면 Windows 방화벽에 인바운드 규칙이 필요합니다.
**관리자 권한 PowerShell**에서 한 번만 실행하세요.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1
```

이 절차 외에 별도의 운영 작업은 없습니다.

---

## 사용 패턴 — 서버를 켤 때만 접속됩니다

이 앱은 클라우드가 아니라 **내 PC에서 돌아갑니다.** PC가 꺼져 있거나 절전이면 아무도 접속할 수 없습니다.
지인 간 소규모 사용을 전제로 한 의도적인 선택입니다.

- 대전은 **약속한 시간에 서버를 켜 두고** 진행하세요.
- **대전 중에는 서버 PC를 절전시키지 마세요.** 절전에서 복귀하면 서버가 마감 시각을 재검증해
  진행 중이던 대전을 즉시 종료 처리합니다.
- 서버가 크래시하거나 재시작되면 **진행 중이던 대전은 무효**이며 전적에 기록되지 않습니다.
  방 목록도 초기화됩니다. (계정·전적·랭킹 등 저장된 데이터는 유지됩니다.)
- 혼자 학습만 할 때는 서버 없이도 되도록 **자립 HTML**을 뽑을 수 있습니다:
  ```bash
  npm run export:round -- 2026-2      # → dist/2026-2.html (파일 열기만으로 동작)
  ```

---

## 데이터베이스

파일 기반이라 별도 DB 설치가 필요 없습니다. 어댑터는 2종입니다.

| 어댑터 | 저장 파일 | 비고 |
|---|---|---|
| `sqlite` (기본) | `data/app.db` | better-sqlite3. Node 20/22/24용 prebuilt 바이너리 사용 |
| `json` (폴백) | `data/app.json` | 순수 JS. 쓰기마다 원자적 임시파일 교체 |

`better-sqlite3` 설치가 실패하면 **자동으로 json 어댑터로 폴백**하며 콘솔에 경고를 남깁니다.
강제로 지정하려면:

```bash
DB_ADAPTER=json npm start        # 폴백 강제
DB_ADAPTER=sqlite npm start      # sqlite 강제
```

두 어댑터는 동일한 도메인 메서드 인터페이스를 구현하며 `tests/db-adapter.test.mjs` 의
계약 테스트를 공유합니다 — 폴백 경로도 상시 검증됩니다.

> **주의**: `better-sqlite3` 는 네이티브 모듈입니다. prebuilt 가 없는 Node 버전에서는
> Visual Studio 빌드 도구가 필요합니다. 없으면 위의 자동 폴백이 동작하므로 그대로 쓰셔도 됩니다.

### 스키마 마이그레이션과 자동 백업

DB 스키마는 `PRAGMA user_version` 으로 버전을 매기고, 기동 시 **밀린 마이그레이션만 순서대로**
적용합니다. 각 단계는 트랜잭션 안에서 돌고 멱등합니다.

- **손대기 전에 통째로 백업합니다**: `data/app.db.bak-YYYYMMDD-HHMMSS`
  (json 어댑터는 `data/app.json.bak-…`). 최근 **5개**만 남기고 오래된 것은 지웁니다.
- 백업은 밀린 마이그레이션이 있을 때만 생깁니다. 새로 만든 DB 는 처음부터 최신 모양이라 백업하지 않습니다.
- 백업 파일은 `.gitignore` 대상입니다. **새 버전을 처음 띄운 직후에는 `data/` 에 `app.db.bak-*` 가
  생겼는지 눈으로 확인**하세요 — 그게 마이그레이션이 실제로 돌았다는 증거입니다.
- 되돌리려면 서버를 끄고 백업 파일을 `data/app.db` 로 되돌린 뒤 이전 버전으로 기동하면 됩니다.

---

## 계정과 세션

- 닉네임(2~12자) + 비밀번호만 받습니다. 이메일·본인확인 없음.
- **비밀번호는 8자 이상**이어야 합니다(가입 시에만 검사하므로 기존 짧은 비밀번호 계정은 그대로 로그인됩니다).
- 비밀번호는 `node:crypto` 의 **scrypt 해시**(비동기)로 저장합니다. 평문은 저장하지 않습니다.
  예전 bcrypt 해시 계정은 다음 로그인 성공 시 그 자리에서 scrypt 로 재저장됩니다.
- 세션은 HMAC 서명 쿠키입니다. 서명 키는 최초 기동 시 `data/secret.key` 에 생성·영속됩니다.
  이 파일은 `.gitignore` 대상이며 유출되면 세션 위조가 가능하니 공유하지 마세요.
- 쿠키는 `HttpOnly; SameSite=Lax; Max-Age=7일` 입니다(예전 30일에서 줄였습니다).
  HTTPS 앞단을 세웠다면 `COOKIE_SECURE=1` 로 띄워 `Secure` 를 켜세요.
- 쿠키에 세션 세대(`session_version`)가 실립니다. DB 의 세대를 올리면 그 사용자의 **기존 쿠키를
  일괄 폐기**할 수 있습니다(세대가 없는 예전 쿠키는 0으로 읽으므로 배포만으로 로그아웃되지 않습니다).
- 로그인 시도는 **닉네임+IP 기준 분당 10회**, 초과하면 5분 잠깁니다. 가입은 IP 기준 분당 5회.
  실패는 서버 로그(stderr)에 남습니다.
- 학습 모드는 비로그인으로도 **풀 수** 있지만 **채점에는 로그인이 필요합니다**(아래 "보안 범위").
  대전·랭킹·오답노트·정답 이의 제기도 로그인이 필요합니다.

---

## 보안 범위

이 앱은 **신뢰하는 지인들만 접속하는 사설 네트워크**를 전제로 합니다.
HTTPS, 이메일 인증, 비밀번호 찾기는 구현하지 않았습니다. 공개 인터넷에 그대로 노출하지 마세요.

정답 데이터(`accept`, `sampleAnswer`, `validator`)는 클라이언트로 전송하지 않으며 채점은 서버에서만 합니다.

모든 응답에 보안 헤더(`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`)와 CSP 가 붙습니다.
CSP 는 `script-src 'self'` · `style-src 'self'` 로 잠겨 있어 **인라인 스크립트·인라인 스타일이 전부 금지**입니다
(`tests/static.test.mjs` 가 `public/` 에 인라인 `<script>`·`<style>`·`style=` 이 0건임을 고정합니다).
문항 본문 HTML 은 `npm run validate` 가 태그·속성 화이트리스트(`div pre br b u table tr th td`, `class` 만)로
검사하므로 스크레이핑 결과에 스크립트나 이벤트 핸들러가 섞여 들어올 수 없습니다.
`npm run export:round` 로 뽑은 자립 HTML에는 정답이 들어 있으므로 **학습용으로만** 쓰고 대전에는 쓰지 마세요.

### 쓰다 보면 마주치는 동작 (의도된 것)

| 상황 | 응답 | 이유 |
|---|---|---|
| 비로그인으로 "제출하고 채점하기" | `401` 로그인이 필요합니다 | 채점 응답에 정답·해설이 실립니다. 무인증이면 그게 곧 **정답 오라클**이라 대전 중에 그대로 베낄 수 있었습니다 |
| 진행 중인 대전의 문항을 학습 화면에서 채점 | `409` 진행 중인 대전의 문항은 채점할 수 없습니다 | 위와 같은 이유의 2차 방어선 |
| 채점을 분당 20회 넘게 | `429` | 정답 전수 조사 방지 |
| 가입 비밀번호 7자 | `400` 비밀번호는 8자 이상이어야 합니다 | |
| 로그인 11회 연속 실패 | `429` (5분 잠금) | 브루트포스 방지 |
| 정답 이의 제기 비로그인 | `401` | 무인증 디스크 쓰기 차단. 답안 칸 10개(각 500자)·의견 2000자·분당 5건 상한도 함께 걸립니다 |
| 방을 4개째 만들기 | `429` | 사용자당 3방 / 전체 200방 / 방당 8명 상한 |
| 7일 뒤 재접속 | 로그아웃 상태 | 세션 쿠키 수명 7일 |
| 인터넷이 끊긴 채 학습 화면 | 상단 알림 + 제출 버튼 잠김 | 답안은 자동 저장되므로 연결이 돌아오면 그대로 채점할 수 있습니다. 오답노트·랭킹도 같은 알림이 뜹니다 |

랜덤 모의고사·오답노트는 서버가 발급한 **세트 토큰**(HMAC, 6시간)으로 채점 대상을 정합니다.
클라이언트가 보낸 문항 id 로 채점 집합을 만들지 않습니다.

### 관리자 페이지

`/admin.html` — 사용자·대전 기록·신고·방 목록·집계를 읽기 전용으로 봅니다.
일반 화면 내비에는 링크가 없고, 주소를 직접 열어야 합니다.

- 계정은 **일반 사용자 계정과 별개**이며 `server/admin.js` 에 있습니다(아이디 `admin`).
  기본 비밀번호가 코드에 들어 있으므로 기동 시 경고가 뜹니다 — `ADMIN_PASSWORD` 환경변수로 바꾸세요.
- 관리자 세션은 별도 쿠키(`jpk_admin`, 12시간)입니다. 일반 세션 쿠키와 **서로 통하지 않습니다**
  (관리자 쿠키로 일반 API 를, 일반 쿠키로 관리자 API 를 쓸 수 없습니다).
- 관리자 로그인도 IP 기준 분당 5회로 제한됩니다. 조회 전용이라 관리자 화면에서 데이터를 고칠 수는 없습니다.

---

## 문제 데이터

- 출처: [chobopark.tistory.com](https://chobopark.tistory.com) 의 복원 기출 (2020년 1회 ~ 2026년 2회, **총 21회차 420문항**). 회차별 출처는 아래 표와 각 JSON 의 `sourceUrl` 에 있습니다.
- 수집 시점에 텍스트/HTML로 변환해 `data/rounds/*.json` 에 저장합니다.
  블로그 이미지 URL은 서명이 만료되므로 **핫링크하지 않습니다**(표·코드는 판독해 HTML로 재현).
- 판독 불가로 제외한 문항은 `data/excluded.md` 에 사유와 함께 기록됩니다.
- 회차별 복원·검증·감사 진행 상황은 `data/PROGRESS.md` 에 있습니다.

### 회차별 출처

| 회차 | 문항 수 | 출처 |
|---|---|---|
| 2020년 1회 | 20 | <https://chobopark.tistory.com/196> |
| 2020년 2회 | 20 | <https://chobopark.tistory.com/195> |
| 2020년 3회 | 20 | <https://chobopark.tistory.com/194> |
| 2020년 4회 | 20 | <https://chobopark.tistory.com/192> |
| 2021년 1회 | 20 | <https://chobopark.tistory.com/191> |
| 2021년 2회 | 20 | <https://chobopark.tistory.com/210> |
| 2021년 3회 | 20 | <https://chobopark.tistory.com/217> |
| 2022년 1회 | 20 | <https://chobopark.tistory.com/271> |
| 2022년 2회 | 20 | <https://chobopark.tistory.com/423> |
| 2022년 3회 | 20 | <https://chobopark.tistory.com/424> |
| 2023년 1회 | 20 | <https://chobopark.tistory.com/372> |
| 2023년 2회 | 20 | <https://chobopark.tistory.com/420> |
| 2023년 3회 | 20 | <https://chobopark.tistory.com/453> |
| 2024년 1회 | 20 | <https://chobopark.tistory.com/476> |
| 2024년 2회 | 20 | <https://chobopark.tistory.com/483> |
| 2024년 3회 | 20 | <https://chobopark.tistory.com/495> |
| 2025년 1회 | 20 | <https://chobopark.tistory.com/540> |
| 2025년 2회 | 20 | <https://chobopark.tistory.com/554> |
| 2025년 3회 | 20 | <https://chobopark.tistory.com/558> |
| 2026년 1회 | 20 | <https://chobopark.tistory.com/561> |
| 2026년 2회 | 20 | <https://chobopark.tistory.com/562> |

### 저작권 방침

타 블로그가 복원한 기출 문제를 **개인 및 지인 간 비공개 학습 용도로만** 사용합니다.
재배포하거나 공개 호스팅하지 않습니다. 각 문항 JSON은 출처 URL을 보존합니다.

### 채점기가 무시하는 차이

단답은 대소문자·모든 공백·후행 구두점(`.` `,` `;` `:`)·**감싼 따옴표**(`"abc"` ≡ `abc`)를 무시합니다.
SQL 문항은 연속 공백을 한 칸으로 줄이고 **쉼표·괄호 주변 공백**(`IN (3, 4)` ≡ `IN(3,4)`)과 후행 세미콜론을 무시합니다.
코드 출력 문항(`keepSpace`)은 내부 공백과 대소문자를 그대로 비교합니다 — 출력값이 곧 정답이기 때문입니다.
규칙의 정본은 `server/grader.js` 머리 주석과 `tests/grader.test.mjs` 입니다.

### 정답이 이상하면

결과 화면의 **"정답 이의 제기"** 버튼을 누르면 `data/reports.jsonl` 에 한 줄씩 신고가 쌓입니다(로그인 필요).
관리자(=서버를 돌리는 사람)가 직접 확인해 반영합니다.
예전 `data/reports.json` 이 남아 있으면 첫 기동 때 자동으로 옮기고 `data/reports.json.migrated` 로 이름을 바꿉니다.

---

## 개발용 명령

### 커밋 전에 할 일

```bash
npm run preflight     # 완료 게이트 — 이게 통과해야 커밋한다
```

**커밋 전에는 `npm run preflight` 를 돌립니다.** 데이터만 손댔다면 훨씬 빠른
`npm run precommit`(검증기 5종) 으로 갈음할 수 있지만, 코드가 한 줄이라도 바뀌었으면 preflight 입니다.
git hook 은 걸지 않았습니다 — 훅은 사람이 `--no-verify` 로 넘겨 버리기 쉽고, 이 저장소는
사람 손으로 커밋하는 규모라 **명령 하나를 규칙으로 두는 편**을 택했습니다.

### 전체 목록

| 명령 | 하는 일 |
|---|---|
| `npm start` | 서버 기동 (`node server/index.js`) |
| `npm test` | 단위·통합 테스트 전부 (`node --test tests/*.test.mjs`) |
| `npm run preflight` | **완료 게이트** — 아래 ①~⑨ 를 순서대로, 첫 실패에서 멈춤 |
| `npm run precommit` | 데이터 게이트 — 검증기 5종만 (테스트·e2e 없이 빠르게) |
| `npm run validate` | 회차 데이터 스키마·자가채점·본문 HTML 화이트리스트 검증 (`data/rounds/*.json`) |
| `npm run validate:explain` | 해설 검증 (`data/explanations/*.json` — 커버리지·허용 태그·길이) |
| `npm run validate:types` | 유형 분류 검증 (`data/types/*.json` — code/sql/theory) |
| `npm run validate:langs` | 언어 분류 검증 (`data/langs/*.json` — c/java/python) |
| `npm run validate:fingerprint` | 문항 지문 서명 대조 (`data/.qfingerprint.json` — 재번호·문항 교체 탐지) |
| `npm run golden:check` | 골든 회귀 — 기존 자산 대비 채점 결과 차이 검사 |
| `npm run headless` | jsdom 으로 실서버를 두드리는 학습 화면 종단 검증 |
| `npm run e2e` | 실서버 2인 소켓 대전 종단 검증 (격리 임시 DB, 실제 `data/` 무영향) |
| `npm run scrape` | 블로그 원본 재수집 (이미 `data/raw/` 에 있으면 불필요) |
| `npm run export:round -- 2026-2` | 회차 → 자립 HTML (`dist/2026-2.html`) |

`validate:*` 3종(explain·types·langs)은 `--partial` 을 붙이면 **존재하는 파일만** 봅니다(집필·분류 중 체크포인트용).
`npm run` 으로는 인자를 넘기기 번거로우니 `node scripts/validate-types.mjs --partial` 처럼 직접 부르세요.

### `npm run preflight` 단계

| 단계 | 내용 | 실패 조건 |
|---|---|---|
| ① 단위 테스트 | `node --test tests/*.test.mjs` | 테스트 실패 |
| ② 데이터 검증 | `validate-data.mjs` | 스키마 위반 · **회차가 21개 미만** |
| ③ 골든 회귀 | `golden-check.mjs` | 채점 결과가 기준과 다름 |
| ④ 종단 대전 | `e2e-battle.js` (격리 임시 `DATA_DIR`, 실서버 2인 소켓) | 시나리오 실패 |
| ⑤ 커버리지 집계 | `data/PROGRESS.md` + `data/excluded.md` 판독 | 표를 읽지 못함 (수치 자체는 보고용) |
| ⑥ 해설 검증 | `validate-explanations.mjs` (전체 모드) | 위반 · **파일 0개** |
| ⑦ 유형 검증 | `validate-types.mjs` (전체 모드) | 위반 · **파일 0개** |
| ⑧ 언어 검증 | `validate-langs.mjs` (전체 모드) | 위반 · **파일 0개** |
| ⑨ 문항 서명 | `fingerprint-questions.mjs` | 서명 불일치 · **`data/.qfingerprint.json` 없음** |

⑥⑦⑧ 은 예전에 "디렉터리가 비어 있으면 집필 전이므로 SKIP" 이었습니다. 세 자산이 전 회차 완비된
지금은 그 SKIP 이 **사이드카 디렉터리를 통째로 지운 사고를 조용히 통과**시키므로 FAIL 로 바꿨습니다.

### 문항 id 규칙 — 재번호 금지

**문항 id 불변 · 삭제 대신 tombstone · 추가는 append only.**

해설·유형·언어 세 사이드카는 문항 id 로 회차 파일과 맞물립니다. 검증기 3종은 **id 집합**만 보므로,
회차 중간 문항을 지우고 뒤 문항을 한 칸씩 당기면(재번호) 집합은 그대로인데 사이드카가 전부
다른 문항을 가리킵니다 — 어느 검증기도 실패하지 않는 유일한 무성 오염입니다.
`data/.qfingerprint.json` 이 그것을 잡습니다(문항 id → 지문·본문·답 칸 수의 sha1).

문항을 정당하게 고쳤다면(오탈자 교정·지문 보강·회차 추가) 서명을 갱신하고 **커밋에 포함**하세요.

```bash
node scripts/fingerprint-questions.mjs --write
```

### 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 수신 포트. `0` 이면 OS 가 비어 있는 포트를 고르는 **임시 포트**(기동 시 `LISTEN_PORT=<n>` 한 줄로 stdout 에 찍힘 — e2e·헤드리스 테스트가 포트 충돌 없이 이걸로 접속). 그 밖의 값은 잘못되면(`abc`, `-1`, 범위 밖) 조용히 3000 으로 떨어지지 않고 에러로 즉시 종료합니다 |
| `DATA_DIR` | `data/` | 계정·전적·신고·세션 키가 저장되는 디렉터리. **회차 JSON 은 항상 `data/rounds/`** 에서 읽습니다 |
| `DB_ADAPTER` | 자동 | `sqlite` \| `json` 강제 지정 |
| `LOG_LEVEL` | (없음) | `debug` 면 대전 `answer`·`tick` 같은 상세 로그까지 찍습니다 |
| `COOKIE_SECURE` | (없음) | `1` 이면 세션·관리자 쿠키에 `Secure` 를 붙입니다 (HTTPS 앞단이 있을 때) |
| `ADMIN_PASSWORD` | 코드 기본값 | 관리자 비밀번호. 설정하지 않으면 기동 시 경고가 뜹니다 |
| `NODE_ENV` | (없음) | `production` 이면 `BATTLE_TIME_OVERRIDE_S`·`BATTLE_COUNTDOWN_MS`·`BATTLE_ABANDON_GRACE_MS`·`BATTLE_ROOM_GC_MS` 백도어를 전부 무시하고 기본값으로 고정합니다 |
| `BATTLE_TIME_OVERRIDE_S` | (없음) | 대전 제한시간 덮어쓰기 (시간 종료 시나리오 테스트용, production 제외) |
| `BATTLE_COUNTDOWN_MS` | `3000` | waiting → playing 카운트다운 길이 덮어쓰기 (e2e 테스트용, production 제외) |
| `BATTLE_ABANDON_GRACE_MS` | `60000` | playing 중 전원 이탈 유예 시간 덮어쓰기 (테스트용, production 제외) |
| `BATTLE_ROOM_GC_MS` | `60000` | 빈 waiting 방 삭제 유예 시간 덮어쓰기 (테스트용, production 제외) |

### 문서

| 파일 | 내용 |
|---|---|
| `SCHEMA.md` | 동결된 문제/DB 스키마와 채점 규칙 — **변경 금지** |
| `PROTOCOL.md` | REST·소켓 프로토콜과 채점 계약 — **변경 금지** |
| `docs/ACCEPTANCE.md` | 인수 체크리스트 |
| `docs/battle-state-grid.md` | 대전 상태 머신 격자표 (상태 × 이벤트 60셀) |
| `docs/explanations/_TEMPLATE.md` | 해설 집필 지침 |
| `docs/explanations/PROGRESS.md` | 회차별 해설 집필 현황 |
| `data/RESTORE_GUIDE.md` | 회차 복원·감사 작업 절차 |
| `data/PROGRESS.md` | 회차별 복원/검증/감사 체크리스트 |
| `data/grading-diff-whitelist.md` | 기존 자산 대비 의도적 채점 차이 목록 |
| `data/excluded.md` | 판독 불가 제외 문항 |

`data/` 의 사이드카 디렉터리(`rounds/` `explanations/` `types/` `langs/`)에는 **회차 JSON 만** 둡니다.
문서는 `docs/` 로 뺐습니다 — 검증기·서명이 `*.json` 만 읽기는 하지만, 자산 디렉터리에 문서가 섞이면
"이 디렉터리가 비었는가" 같은 판단이 흐려집니다.
