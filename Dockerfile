# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine
LABEL org.opencontainers.image.title="alimail-admin-mcp" \
      org.opencontainers.image.description="MCP server for Alibaba Mail admin OpenAPI (unofficial)" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    # Only used with --http. Inside a container the server must listen on all interfaces
    # to be reachable through a published port; Host-header validation still applies.
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# Default: stdio transport (use `docker run -i`). Append `--http` for Streamable HTTP.
ENTRYPOINT ["node", "dist/index.js"]
