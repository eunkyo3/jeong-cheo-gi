# 정처기 배틀 — 실행 이미지
#
#   docker compose up -d --build        # 빌드 + 기동 (docs/DOCKER.md)
#
# glibc 기반 slim 을 쓰는 이유: better-sqlite3 가 linux-glibc 용 prebuilt 바이너리를 제공해
# 컴파일러 없이 npm ci 가 끝난다 (alpine/musl 은 빌드 툴체인이 필요할 수 있다).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

WORKDIR /app

# 의존성 레이어 — package*.json 이 바뀔 때만 다시 받는다
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 앱 본체. 무엇이 제외되는지는 .dockerignore 참고 (DB·비밀키·로그는 이미지에 들어가지 않는다)
COPY . .

# 런타임 상태(app.db·secret.key·reports.jsonl·backups/)는 /data 볼륨에. node 사용자로 실행.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000

# 서버가 살아 있는지 — 회차 목록 API 가 200 이면 정상 (Node 24 내장 fetch)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/rounds').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
