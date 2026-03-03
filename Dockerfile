# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

# Build tools for native modules (bcrypt, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

# Install server dependencies first (cache layer)
COPY novabot-server/package.json novabot-server/package-lock.json* novabot-server/
RUN cd novabot-server && npm ci

# Install dashboard dependencies
COPY novabot-dashboard/package.json novabot-dashboard/package-lock.json* novabot-dashboard/
RUN cd novabot-dashboard && npm ci

# Copy source and build server
COPY novabot-server/src novabot-server/src
COPY novabot-server/tsconfig.json novabot-server/
RUN cd novabot-server && npm run build

# Copy source and build dashboard
COPY novabot-dashboard/src novabot-dashboard/src
COPY novabot-dashboard/tsconfig.json novabot-dashboard/tsconfig.app.json novabot-dashboard/tsconfig.node.json novabot-dashboard/
COPY novabot-dashboard/vite.config.ts novabot-dashboard/
COPY novabot-dashboard/index.html novabot-dashboard/
COPY novabot-dashboard/public novabot-dashboard/public
RUN cd novabot-dashboard && npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache dnsmasq

WORKDIR /app

# Copy compiled server + production dependencies
COPY --from=build /app/novabot-server/dist novabot-server/dist
COPY --from=build /app/novabot-server/node_modules novabot-server/node_modules
COPY --from=build /app/novabot-server/package.json novabot-server/

# Copy built dashboard
COPY --from=build /app/novabot-dashboard/dist novabot-dashboard/dist

# Copy entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Persistent data directory
RUN mkdir -p /data/storage /data/firmware

# Ports: DNS, HTTP (mower compat), MQTT, API+Dashboard
EXPOSE 53/udp 53/tcp 80 1883 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
