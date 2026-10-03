# ---- build stage -------------------------------------------------------------
# Compiles the collector (tsc -> dist/server) and the dashboard (Vite -> dist/web) in one image.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime stage -----------------------------------------------------------
# No native modules: SQLite comes from Node's built-in node:sqlite, so the runtime image is Node + dist + the built site.
FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --chown=node:node --chmod=644 package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
# --chmod: host file modes (e.g. a 0600 seed list) must not make the files unreadable for the unprivileged user below.
COPY --chown=node:node --chmod=644 data/seeds ./data/seeds
COPY --chown=node:node --chmod=644 data/protocol-versions.json ./data/protocol-versions.json
RUN mkdir -p /data && chown node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server/index.js"]
