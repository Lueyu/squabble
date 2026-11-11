# ---------- Build stage ----------
# ARG BASE_REGISTRY lets users behind a firewall pull through a mirror, e.g.
#   docker compose build --build-arg BASE_REGISTRY=docker.m.daocloud.io/library
ARG BASE_REGISTRY=library
FROM ${BASE_REGISTRY}/node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=2048
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
# The prepare lifecycle script references this file; it must exist before npm ci.
COPY scripts/setup-git-hooks.js scripts/
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Honor the lock's integrity hashes while avoiding a required regional registry.
RUN --mount=type=cache,target=/root/.npm npm ci --registry="$NPM_REGISTRY" --replace-registry-host=always --fetch-retries=4 --maxsockets=8

FROM dependencies AS build
COPY . .
# The container runs the web stack; the desktop installer is built separately.
ARG VITE_PUBLIC_DEPLOYMENT=false
ENV VITE_PUBLIC_DEPLOYMENT=${VITE_PUBLIC_DEPLOYMENT}
RUN npm run build:web

# ---------- Production packages ----------
FROM build AS production-deps
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
# Exact Playwright 1.65.0 amd64 image includes matching Chromium/OS libraries.
FROM mcr.microsoft.com/playwright@sha256:bc4fbb329a25287ed23e9216c97063646abdd1bf2da669a9895fa3e2078b2302
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/Lueyu/squabble"
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.secrets /app/.local-agents /app/.backups /app/.data/research-artifacts /app/logs \
    && chown -R 1000:1000 /app
# Keep Node 24 independently of the browser image's Node release.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3000 \
    LOCAL_AGENTS_MODE=companion \
    LOCAL_AGENTS_DATA_DIR=/app/.local-agents \
    RESEARCH_ARTIFACT_ROOT=/app/.data/research-artifacts \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=production-deps /app/package.json /app/package-lock.json ./
COPY --from=production-deps /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY scripts/db/ ./scripts/db/
COPY scripts/ensure-settings-key.cjs scripts/ensure-jwt-secret.cjs scripts/start-app.cjs ./scripts/
COPY deploy/bundle-init.cjs deploy/browser-smoke.cjs ./deploy/

# Views and static assets are resolved from process.cwd()/dist/client
# (server/main.ts), so the working directory must stay /app.
USER 1000:1000
CMD ["node", "scripts/start-app.cjs"]
