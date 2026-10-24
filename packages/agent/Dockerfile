FROM --platform=linux/arm64 node:22-alpine AS builder

# Required to compile native modules (e.g. better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Copy workspace root
COPY package.json tsconfig.base.json ./

# Copy package manifests (all packages the agent depends on)
COPY packages/agent/package.json ./packages/agent/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp-url-fetcher/package.json ./packages/mcp-url-fetcher/

# Install all dependencies (including native modules like better-sqlite3)
RUN npm install --workspaces

# Copy source
COPY packages/agent/src ./packages/agent/src
COPY packages/agent/tsconfig.json ./packages/agent/
COPY packages/db/src ./packages/db/src
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/mcp-url-fetcher/src ./packages/mcp-url-fetcher/src
COPY packages/mcp-url-fetcher/tsconfig.json ./packages/mcp-url-fetcher/

# Build
RUN npm run -w @arbor/db build
RUN npm run -w @arbor/mcp-url-fetcher build
RUN npm run -w @arbor/agent build

# ---------------------------------------------------------------------------
# Migration runner — runs drizzle-kit migrate and exits
# ---------------------------------------------------------------------------
FROM --platform=linux/arm64 node:22-alpine AS migrate

WORKDIR /app

COPY --from=builder /build/packages/db/dist ./packages/db/dist
COPY --from=builder /build/packages/db/package.json ./packages/db/
COPY --from=builder /build/packages/db/src ./packages/db/src
COPY packages/db/drizzle ./packages/db/drizzle
COPY packages/db/drizzle.config.ts ./packages/db/
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./

WORKDIR /app/packages/db
CMD ["/app/node_modules/.bin/drizzle-kit", "migrate"]

# ---------------------------------------------------------------------------
FROM --platform=linux/arm64 node:22-alpine AS runtime

WORKDIR /app

# Copy built output and production dependencies
COPY --from=builder /build/packages/agent/dist ./packages/agent/dist
COPY --from=builder /build/packages/agent/package.json ./packages/agent/
COPY --from=builder /build/packages/db/dist ./packages/db/dist
COPY --from=builder /build/packages/db/package.json ./packages/db/
COPY --from=builder /build/packages/mcp-url-fetcher/dist ./packages/mcp-url-fetcher/dist
COPY --from=builder /build/packages/mcp-url-fetcher/package.json ./packages/mcp-url-fetcher/
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./

# Copy entrypoint script
COPY packages/agent/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Pre-install the MCP servers
RUN npm install -g \
  @a-bonus/google-docs-mcp \
  @modelcontextprotocol/server-github

# Patch: add corpora=allDrives to every files.list call so the service
# account can see Shared Drive content (not just files it owns).
RUN find /usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist -name "*.js" \
  -exec sed -i \
    's/includeItemsFromAllDrives: true,/includeItemsFromAllDrives: true, corpora: '"'"'allDrives'"'"',/g' \
    {} \; \
  && grep -qr "corpora.*allDrives" \
     /usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist/tools/drive/ \
  || { echo "ERROR: corpora=allDrives patch did not apply"; exit 1; }

ENV NODE_ENV=production

ENTRYPOINT ["/app/docker-entrypoint.sh"]
