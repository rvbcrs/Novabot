# ── Stage 1: Build wizard (React + Vite) ──────────────────────────────────────
FROM node:20-alpine AS wizard-build

WORKDIR /app/wizard
COPY wizard/package.json wizard/package-lock.json* ./
RUN npm ci
COPY wizard/ ./
RUN npm run build

# ── Stage 2: Build server (TypeScript) ────────────────────────────────────────
FROM node:20-alpine AS server-build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source first (needed for generate-wizard-bundle output path)
COPY src/ src/
COPY tsconfig.json ./

# Generate wizard bundle from built wizard dist into src/
COPY scripts/ scripts/
COPY --from=wizard-build /app/wizard/dist wizard/dist
RUN node scripts/generate-wizard-bundle.mjs

# Build server (tsc compiles src/ including the generated wizard-bundle.ts)
RUN npx tsc

# Inject version into built JS
RUN node -e "const fs=require('fs'),v=require('./package.json').version; const f='dist/server.js'; fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace('__APP_VERSION__',v));"

# ── Stage 3: Production ──────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache zip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=server-build /app/dist dist/

ENV DOCKER=1
ENV PORT=7780
EXPOSE 7780

CMD ["node", "dist/index.js"]
