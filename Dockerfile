# ── Stage 1: Build (TypeScript compilatie) ────────────────────────────────────
FROM node:20-alpine AS build

# Build tools for native modules (bcrypt, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

# Install server dependencies first (cache layer)
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm ci

# Install dashboard dependencies
COPY dashboard/package.json dashboard/package-lock.json* dashboard/
RUN cd dashboard && npm ci

# Copy source and build server
COPY server/src server/src
COPY server/tsconfig.json server/
RUN cd server && npm run build

# Copy source and build dashboard
COPY dashboard/src dashboard/src
COPY dashboard/tsconfig.json dashboard/tsconfig.app.json dashboard/tsconfig.node.json dashboard/
COPY dashboard/vite.config.ts dashboard/
COPY dashboard/index.html dashboard/
COPY dashboard/public dashboard/public
RUN cd dashboard && npm run build


# ── Stage 2: Production dependencies (lean) ──────────────────────────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app

COPY server/package.json server/package-lock.json* server/

# Install production deps only (no typescript, tsx, @types, etc.)
RUN cd server && npm ci --omit=dev

# Remove packages not needed in Docker:
# - @stoprocent/noble + usb + @serialport = BLE (no adapter in Docker)
# - ssh2 + cpu-features = SSH to mower (dev-only feature)
# All imports are dynamic — server runs fine without them.
RUN cd server && \
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
RUN cd server/node_modules/better-sqlite3 && \
    rm -rf deps src build/deps build/test_extension* build/*.mk build/Makefile \
           build/config.gypi build/gyp-mac-tool build/binding.Makefile 2>/dev/null; true


# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache dnsmasq nginx openssl

WORKDIR /app

# Copy compiled server + lean production dependencies
COPY --from=build /app/server/dist server/dist
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/server/package.json server/

# Copy built dashboard
COPY --from=build /app/dashboard/dist dashboard/dist

# Copy factory device database (SN → MAC lookup for BLE provisioning)
COPY server/cloud_devices_anonymous.json server/cloud_devices_anonymous.json

# Copy entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Persistent data directory
RUN mkdir -p /data/storage /data/firmware

# Ports: DNS, HTTP, HTTPS (app), MQTT, API+Dashboard
EXPOSE 53/udp 53/tcp 80 443 1883 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
