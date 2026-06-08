# syntax=docker/dockerfile:1

# Node 22 LTS satisfies the package.json engines requirement (>=20.19.0).
ARG NODE_VERSION=22

# --- Build stage: install dev deps (tsgo) and compile TS -> dist ----------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# pnpm via corepack, pinned to the lockfile major (lockfileVersion 9.0 -> pnpm 9).
RUN corepack enable && corepack prepare pnpm@9 --activate

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Compile. tsconfig includes src and tests; both are needed for the build.
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN pnpm run build

# --- Runtime stage: no npm dependencies, only the compiled output ---------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    STATE_FILE=/data/state.json

# tini reaps zombies and forwards SIGTERM so the poller aborts cleanly.
RUN apk add --no-cache tini \
 && mkdir -p /data \
 && chown node:node /data

# package.json is required at runtime for "type": "module" resolution.
# This project declares no runtime dependencies, so no node_modules is copied.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=builder /app/dist/src ./dist/src

USER node
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/cli.js"]
