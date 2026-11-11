FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv
FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /opt/squabble-analytics
COPY workers/analytics/pyproject.toml workers/analytics/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY workers/analytics/ ./
RUN printf '%s\n' '/opt/squabble-analytics' > .venv/lib/python3.12/site-packages/squabble-analytics.pth && useradd --uid 10001 --create-home analyst
ENV PATH=/opt/squabble-analytics/.venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 MPLCONFIGDIR=/tmp/matplotlib
USER 10001:10001
ENTRYPOINT ["/opt/squabble-analytics/.venv/bin/python", "-I", "/opt/squabble-analytics/launcher.py"]
