# ---------------------------------------------------------------- build ----
# Builds both workspaces. The web bundle is emitted into the image so the API
# can serve it: one origin, one deployable, no CORS in the request path.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci

COPY . .
RUN npm run build --workspace=frontend \
 && npm run build --workspace=backend

# ----------------------------------------------------------------- deps ----
# Production dependencies only, resolved separately so the build toolchain
# never reaches the runtime image.
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace=@bookingmaster/backend --include-workspace-root \
 # npm hoists what it can, but a workspace whose range conflicts with the root
 # keeps its own copy here. Created unconditionally so the COPY below cannot
 # start failing if a future resolution hoists everything.
 && mkdir -p /app/backend/node_modules

# -------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/frontend/dist

# Behind a PaaS router by default, so rate limiting sees the real client IP.
ENV TRUST_PROXY=true

RUN apk add --no-cache tini wget

COPY --from=deps  /app/node_modules      ./node_modules
# Not redundant: npm leaves a workspace's conflicting versions here rather than
# hoisting them. Without this the image silently runs whatever the root
# happened to hoist — dotenv 16.4.5, where the backend asks for ^16.4.7 — and
# nothing says so until a version difference matters.
COPY --from=deps  /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist      ./backend/dist
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/frontend/dist     ./frontend/dist
COPY package.json ./
COPY backend/package.json ./backend/
COPY docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node:alpine ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health/ready || exit 1

# tini reaps zombies and forwards SIGTERM, which is what lets Nest's shutdown
# hooks actually run and drain the connection pool.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
