# ---------- Build stage ----------
# ARG BASE_REGISTRY lets users behind a firewall pull through a mirror, e.g.
#   docker compose build --build-arg BASE_REGISTRY=docker.m.daocloud.io/library
ARG BASE_REGISTRY=library
FROM ${BASE_REGISTRY}/node:22-alpine AS build
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
FROM ${BASE_REGISTRY}/node:22-alpine
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
COPY scripts/db/03_agent_builder.sql ./scripts/db/03_agent_builder.sql
COPY scripts/db/04_user_api_settings.sql ./scripts/db/04_user_api_settings.sql
COPY scripts/db/05_analysis_language.sql ./scripts/db/05_analysis_language.sql
COPY scripts/db/06_account_recovery.sql ./scripts/db/06_account_recovery.sql
COPY scripts/db/07_llm_budget.sql ./scripts/db/07_llm_budget.sql
COPY scripts/db/08_investment_council.sql ./scripts/db/08_investment_council.sql
COPY scripts/db/09_builder_cadence.sql ./scripts/db/09_builder_cadence.sql
COPY scripts/db/10_model_connections.sql ./scripts/db/10_model_connections.sql
COPY scripts/db/11_research_tools.sql ./scripts/db/11_research_tools.sql
COPY scripts/db/12_council_dialogue.sql ./scripts/db/12_council_dialogue.sql
COPY scripts/db/13_budget_toggle.sql ./scripts/db/13_budget_toggle.sql
COPY scripts/db/14_a2a_agents.sql ./scripts/db/14_a2a_agents.sql
COPY scripts/db/15_native_agents.sql ./scripts/db/15_native_agents.sql
COPY scripts/db/16_daily_strategy.sql ./scripts/db/16_daily_strategy.sql
COPY scripts/db/17_research_memory.sql ./scripts/db/17_research_memory.sql
COPY scripts/db/18_research_workflow.sql ./scripts/db/18_research_workflow.sql
COPY scripts/db/19_local_model_route.sql ./scripts/db/19_local_model_route.sql
COPY scripts/db/20_portfolio_report.sql ./scripts/db/20_portfolio_report.sql
COPY scripts/ensure-settings-key.cjs scripts/ensure-jwt-secret.cjs scripts/start-app.cjs ./scripts/

# Views and static assets are resolved from process.cwd()/dist/client
# (server/main.ts), so the working directory must stay /app.
CMD ["node", "scripts/start-app.cjs"]
