# ── Build stage ──
FROM node:18-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ──
FROM node:18-alpine
RUN apk add --no-cache libstdc++
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Marketplace data lives on a persistent volume
ENV NODE_ENV=production
ENV MARKETPLACE_PORT=3141
ENV MARKETPLACE_DB_PATH=/data/marketplace.db

EXPOSE 3141

CMD ["node", "dist/marketplace/cli.mjs"]
