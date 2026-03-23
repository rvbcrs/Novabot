# ── Stage 1: Build (TypeScript compilatie) ────────────────────────────────────
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


# ── Stage 2: Production dependencies (lean) ──────────────────────────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

COPY novabot-server/package.json novabot-server/package-lock.json* novabot-server/

# Install production deps only (no typescript, tsx, @types, etc.)
RUN cd novabot-server && npm ci --omit=dev

# Remove packages not needed in Docker:
# - @stoprocent/noble + usb + @serialport = BLE (no adapter in Docker)
# - ssh2 + cpu-features = SSH to mower (dev-only feature)
# All imports are dynamic — server runs fine without them.
RUN cd novabot-server && \
    rm -rf node_modules/@stoprocent \
           node_modules/noble \
           node_modules/usb \
           node_modules/@serialport \
           node_modules/serialport \
           node_modules/ssh2 \
           node_modules/cpu-features \
           node_modules/@noble

# Strip better-sqlite3: remove build artifacts not needed at runtime
# The .node binary in build/Release is needed; deps/ and src/ are not.
RUN cd novabot-server/node_modules/better-sqlite3 && \
    rm -rf deps src build/deps build/test_extension* build/*.mk build/Makefile \
           build/config.gypi build/gyp-mac-tool build/binding.Makefile 2>/dev/null; true


# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache dnsmasq nginx openssl

WORKDIR /app

# Copy compiled server + lean production dependencies
COPY --from=build /app/novabot-server/dist novabot-server/dist
COPY --from=deps /app/novabot-server/node_modules novabot-server/node_modules
COPY --from=deps /app/novabot-server/package.json novabot-server/

# Copy built dashboard
COPY --from=build /app/novabot-dashboard/dist novabot-dashboard/dist

# Copy setup wizard (static HTML, no build needed)
COPY setup-wizard setup-wizard

# Copy entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Persistent data directory
RUN mkdir -p /data/storage /data/firmware

# Ports: DNS, HTTP, HTTPS (app), MQTT, API+Dashboard
EXPOSE 53/udp 53/tcp 80 443 1883 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
