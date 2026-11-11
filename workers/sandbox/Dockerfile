FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN apk add --no-cache docker-cli=29.9.3-r1
WORKDIR /opt/squabble-sandbox
COPY workers/sandbox/broker.cjs ./broker.cjs
COPY workers/sandbox/acceptance.cjs ./acceptance.cjs
COPY LICENSE ./LICENSE
ENV SANDBOX_LISTEN_HOST=0.0.0.0 SANDBOX_PORT=8093 SANDBOX_STATE_DIR=/var/lib/squabble-sandbox SANDBOX_TOKEN_FILE=/run/secrets/sandbox-token
EXPOSE 8093
CMD ["node", "broker.cjs"]
