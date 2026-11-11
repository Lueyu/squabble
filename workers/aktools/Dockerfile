FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
COPY --from=uv /uv /usr/local/bin/uv
COPY workers/aktools/requirements-linux.lock /opt/squabble/requirements-linux.lock
RUN uv pip install --system --require-hashes --no-cache -r /opt/squabble/requirements-linux.lock \
    && useradd --create-home --uid 1000 aktools
COPY deploy/bundle_gateway.py /opt/squabble/bundle_gateway.py
COPY workers/aktools/licenses /opt/squabble/licenses
WORKDIR /home/aktools
USER 1000:1000
ENV BUNDLE_ENGINE=aktools BUNDLE_PORT=8081 BUNDLE_TOKEN_FILE=/run/secrets/aktools-token \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 AKTOOLS_TIMEOUT=30
EXPOSE 8081
ENTRYPOINT ["python", "/opt/squabble/bundle_gateway.py"]
