# ---------- Build stage ----------
# ARG BASE_REGISTRY lets users behind a firewall pull through a mirror, e.g.
#   docker compose build --build-arg BASE_REGISTRY=docker.m.daocloud.io/library
ARG BASE_REGISTRY=library
FROM ${BASE_REGISTRY}/node:24-alpine AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
# The prepare lifecycle script references this file; it must exist before npm ci.
COPY scripts/setup-git-hooks.js scripts/
RUN npm ci

COPY . .
# The container runs the web stack; the desktop installer is built separately.
ARG VITE_PUBLIC_DEPLOYMENT=false
ENV VITE_PUBLIC_DEPLOYMENT=${VITE_PUBLIC_DEPLOYMENT}
RUN npm run build:web

# ---------- Runtime stage ----------
FROM ${BASE_REGISTRY}/node:24-alpine
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/Lueyu/squabble"
RUN apk add --no-cache postgresql16-client
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3000 \
    LOCAL_AGENTS_MODE=companion \
    LOCAL_AGENTS_DATA_DIR=/app/.local-agents

COPY package.json package-lock.json .npmrc ./
COPY scripts/setup-git-hooks.js scripts/
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY scripts/db/ ./scripts/db/
COPY scripts/ensure-settings-key.cjs scripts/ensure-jwt-secret.cjs scripts/start-app.cjs ./scripts/

# Views and static assets are resolved from process.cwd()/dist/client
# (server/main.ts), so the working directory must stay /app.
CMD ["node", "scripts/start-app.cjs"]
