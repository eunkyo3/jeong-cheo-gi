# 정처기 배틀 — 정보처리기사 실기 기출 학습·대전 웹앱

내 PC에서 Node.js 서버 하나를 띄우고, 같은 네트워크(또는 Tailscale)의 친구들이 브라우저로 접속해
정보처리기사 실기 복원 기출을 **혼자 학습**하거나 **실시간으로 대전**하는 웹앱입니다.

- 학습 모드: 회차 선택 → 풀이 → 즉시 채점(100점 만점) → 틀린 문제마다 **AI 질문 프롬프트 복사**
- 대전 모드: 닉네임+비밀번호로 로그인 → 방 생성/참여 → 동시 시작 → 실시간 진행 현황 → 승자 판정
- 랭킹: 대전 전적(승/무/패/승점) 기준 순위
- 유형별 학습: 문항을 **코드 · SQL · 이론**으로 나눠 원하는 유형만 골라 풀기 (학습·모의고사·오답노트·대전 전부)
- 해설: **420문항 전 문항 해설** — 채점 후에만 문항별 "해설 보기" (비전공자 눈높이, 핵심 강조 표시)

### 학습 이력 · 오답노트 · 랜덤 모의고사

로그인한 채로 채점하면 회차별 응시 횟수·최고점·최근 점수가 쌓이고, **틀린 문항이 자동으로 오답노트에 모입니다**
(나중에 그 문항을 맞히면 노트에서 빠집니다). 여러 회차를 섞어 5~60문항을 뽑는 **랜덤 모의고사**도 학습 모드에서 바로 풀 수 있습니다.
오답노트와 모의고사 결과 역시 이력에 함께 기록됩니다.

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

| 모바일 — 오답노트 채점 | 모바일 — AI 질문 복사(클립보드 폴백 모달) |
|---|---|
| <img src="docs/screenshots/10-mobile-wrong-note.png" width="300"> | <img src="docs/screenshots/11-mobile-ai-copy-modal.png" width="300"> |

---

## 실행

```bash
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

---

## 계정과 세션

- 닉네임(2~12자) + 비밀번호만 받습니다. 이메일·본인확인 없음.
- 비밀번호는 **bcrypt 해시**로 저장합니다. 평문은 저장하지 않습니다.
- 세션은 HMAC 서명 쿠키입니다. 서명 키는 최초 기동 시 `data/secret.key` 에 생성·영속됩니다.
  이 파일은 `.gitignore` 대상이며 유출되면 세션 위조가 가능하니 공유하지 마세요.
- 쿠키는 `HttpOnly; SameSite=Lax; Max-Age=30일` 입니다. HTTP로 운영하므로 `Secure` 는 붙이지 않습니다.
- **무상태 서명 쿠키의 한계**: 로그아웃은 브라우저의 쿠키를 지우는 방식입니다.
  이미 발급된 쿠키를 서버에서 강제 만료시키는 기능은 없습니다. 지인 간 사용을 전제한 수용입니다.
- 학습 모드는 비로그인으로도 쓸 수 있습니다. 대전과 랭킹은 로그인이 필요합니다.

---

## 보안 범위

이 앱은 **신뢰하는 지인들만 접속하는 사설 네트워크**를 전제로 합니다.
HTTPS, 이메일 인증, 비밀번호 찾기, 계정 잠금, 요청 제한(rate limit)은 구현하지 않았습니다.
공개 인터넷에 그대로 노출하지 마세요.

정답 데이터(`accept`, `sampleAnswer`, `validator`)는 클라이언트로 전송하지 않으며 채점은 서버에서만 합니다.
`npm run export:round` 로 뽑은 자립 HTML에는 정답이 들어 있으므로 **학습용으로만** 쓰고 대전에는 쓰지 마세요.

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

### 정답이 이상하면

결과 화면의 **"정답 이의 제기"** 버튼을 누르면 `data/reports.json` 에 신고가 쌓입니다.
관리자(=서버를 돌리는 사람)가 직접 확인해 반영합니다.

---

## 개발용 명령

```bash
npm test                        # grader / battle / db 어댑터 / 랭킹 단위 테스트
npm run e2e                     # 실서버 2인 대전 종단 검증 (격리 임시 DB, 실제 data/ 무영향)
npm run preflight               # 위 전부 + validate + 골든 회귀 + 커버리지 — 완료 게이트
npm run validate                # 전 회차 문제 데이터 스키마·자가채점 검증
npm run scrape                  # 블로그 원본 재수집 (이미 data/raw/ 에 있으면 불필요)
npm run export:round -- 2026-2  # 회차 → 자립 HTML
```

환경변수:
- `BATTLE_TIME_OVERRIDE_S` — 대전 제한시간 덮어쓰기 (시간 종료 시나리오 테스트용)
- `DATA_DIR` — 계정·전적·신고·세션 키가 저장되는 디렉터리 (기본 `data/`). 회차 JSON 은 항상 `data/rounds/` 에서 읽는다.

### 문서

| 파일 | 내용 |
|---|---|
| `SCHEMA.md` | 동결된 문제/DB 스키마와 채점 규칙 — **변경 금지** |
| `data/RESTORE_GUIDE.md` | 회차 복원·감사 작업 절차 |
| `data/PROGRESS.md` | 회차별 복원/검증/감사 체크리스트 |
| `data/grading-diff-whitelist.md` | 기존 자산 대비 의도적 채점 차이 목록 |
| `data/excluded.md` | 판독 불가 제외 문항 |
