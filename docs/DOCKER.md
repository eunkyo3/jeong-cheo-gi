# Docker 로 띄우기

목적: **이 노트북이 없을 때 다른 PC 에서 같은 앱을 한 줄로** 띄우고, 계정·전적을 그대로 이어서 쓴다.

런타임(Node·의존성·문항 데이터)은 이미지가 옮겨 주지만 **계정·전적·비밀키(`app.db`·`secret.key`·`reports.jsonl`)는 이미지에 들어가지 않는다** — 컨테이너의 `/data` 볼륨에 산다. 그래서 "다른 장소에서 이어서 쓰기"는 아래 3단계다: 백업 뜨기 → 파일 옮기기 → 복원.

## 1. 처음 띄우기 (어느 PC 든)

```sh
git clone <repo> && cd jpk-battle
cp .env.example .env      # ADMIN_PASSWORD 를 채운다 — 비어 있으면 compose 가 기동을 거부한다
docker compose up -d --build
```

- 접속: `http://localhost:3000` (다른 포트는 `.env` 의 `HOST_PORT`). 같은 LAN 의 다른 기기는 호스트 IP 로.
- 상태: `docker compose ps` — `healthy` 면 `/api/rounds` 가 200 을 돌려주고 있다는 뜻.
- 로그: `docker compose logs -f app`
- 멈춤/재기동: `docker compose stop` / `docker compose up -d`
- 코드 갱신 후: `git pull && docker compose up -d --build` (데이터 볼륨은 유지된다)

컨테이너는 `NODE_ENV=production` 으로 뜬다 → 테스트용 `BATTLE_*` 오버라이드는 전부 무시된다(README 환경변수 표).

## 2. 기존 데이터를 컨테이너로 가져오기

지금 `node server/index.js` 로 직접 돌리던 PC 의 데이터를 도커 볼륨으로 옮긴다.

```sh
# (a) 직접 실행 중인 서버 옆에서 — 서버가 떠 있어도 안전(온라인 백업)
npm run db:backup
#   → data/backups/<stamp>/{app.db, secret.key, reports.jsonl}

# (b) 컨테이너의 /data 에 복원 — app 컨테이너는 내려 둔다
docker compose stop app
docker compose run --rm --no-deps -v "${PWD}/data/backups/<stamp>:/import:ro" app node scripts/db-restore.mjs /import --force
#   PowerShell·bash·mac·리눅스 공통 ${PWD}. cmd.exe 는 %CD%\data\backups\<stamp>
#   --force 인 이유: 1 번의 첫 기동이 이미 빈 app.db 를 만들어 두었기 때문. 없으면 거부하고 멈춘다.
#   덮인 기존 파일은 /data 에 .bak-<stamp> 로 남는다

docker compose up -d
```

`secret.key` 까지 같이 옮기므로 로그인 세션·모의고사 세트 토큰이 그대로 유효하다. 안 옮기면 첫 기동 때 새 키가 생기고 전원 재로그인.

## 3. 다른 PC 로 옮기기

```sh
# 지금 PC (컨테이너에서 백업 뜨기)
docker compose exec app node scripts/db-backup.mjs        # → 컨테이너 /data/backups/<stamp>/
docker compose cp app:/data/backups/. ./data/backups       # 호스트로 꺼냄 (끝의 /. 가 없으면 backups/backups/ 로 겹친다)

# 폴더 data/backups/<stamp> 를 USB·클라우드 등으로 다른 PC 의 jpk-battle/data/backups/ 에 복사

# 다른 PC
docker compose up -d --build            # 1 번 절차 (첫 기동, 빈 DB)
docker compose stop app
docker compose run --rm --no-deps -v "${PWD}/data/backups/<stamp>:/import:ro" app node scripts/db-restore.mjs /import --force
docker compose up -d
```

양쪽에서 번갈아 쓰면 **마지막에 백업한 쪽이 이긴다** — DB 병합은 없다. 항상 "떠나기 전에 백업, 도착해서 복원" 순서를 지킨다.

## 4. 주의

- **Windows 호스트에서 `./data:/data` 같은 bind mount 를 쓰지 말 것.** SQLite WAL 의 `-wal`/`-shm` 공유 메모리가 Docker Desktop 의 파일 공유 위에서 깨질 수 있다. compose 는 그래서 named volume(`jpk-data`)을 쓴다. 볼륨 위치를 알 필요는 없고, 꺼낼 때는 위의 `docker compose cp` 를 쓴다.
- 볼륨 삭제 = 데이터 삭제: `docker compose down -v` 는 계정·전적을 지운다. 평소 `docker compose down`(v 없이)만.
- HTTPS 는 앱에 없다. 외부에 열려면 Caddy/nginx 를 앞에 두고 `.env` 에 `COOKIE_SECURE=1`. LAN·Tailscale 안에서만 쓰면 그대로 둔다.
- 기동 배너에 찍히는 LAN 주소는 **컨테이너 안** 주소라 의미가 없다. 호스트 IP 로 접속한다.
- 이미지에 들어가는 것/안 들어가는 것의 목록은 `.dockerignore`.

## 스크립트 요약

| 명령 | 하는 일 |
|---|---|
| `npm run db:backup [출력경로]` | `DATA_DIR` 의 app.db 를 온라인 백업으로 뜨고 secret.key·reports.jsonl 과 묶는다. 서버 켜진 채 OK |
| `npm run db:restore <묶음경로> [--force]` | 묶음을 `DATA_DIR` 로 복원. **서버 내리고** 실행. 기존 파일은 `.bak-<stamp>` |

둘 다 서버와 같은 `DATA_DIR` 규약(기본 `data/`, 컨테이너는 `/data`)을 따른다.
