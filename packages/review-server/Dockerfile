# 极简评审协同 hub。镜像内不含 lark-cli、不含 Anthropic SDK、不含 MCP SDK。
FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 需要本地编译依赖
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json ./
# rollup 依赖平台 native 包，必须保留 optional deps
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsup src/index.ts --format esm --target node20 --no-splitting --external better-sqlite3

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache libstdc++

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --omit=optional \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    REVIEW_SERVER_PORT=4100 \
    REVIEW_DB_PATH=/data/review-server.db

VOLUME ["/data"]
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:4100/api/health || exit 1

CMD ["node", "dist/index.js"]
