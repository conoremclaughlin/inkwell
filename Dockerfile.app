FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Needed by scripts/prod-direct.sh health checks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages

RUN corepack enable
RUN yarn install --immutable
RUN yarn build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENV NODE_ENV=production
ENV PCP_PORT_BASE=3001
ENV WEB_PORT=3002
ENV MYRA_HTTP_PORT=3003
ENV API_URL=http://localhost:3001
ENV ENABLE_TELEGRAM=false
ENV ENABLE_WHATSAPP=false
ENV ENABLE_DISCORD=false

EXPOSE 3001 3002 3003

ENTRYPOINT ["tini", "--"]
CMD ["./scripts/prod-direct.sh"]
