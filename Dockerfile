# syntax=docker/dockerfile:1
# Vengtoo MCP Gateway — self-host / reference PEP.
# Runs @vengtoo/mcp-gateway in HTTP mode: it proxies your MCP server(s) and
# authorizes every tools/call against the Vengtoo PDP before it executes.
#
#   docker build -t vengtoo/mcp-gateway .
#   docker run --rm -p 8808:8808 \
#     -e VENGTOO_API_KEY=vgt_live_... \
#     -e VENGTOO_GATEWAY_HTTP_CALLERS="tok_abc=agent:claude" \
#     -v "$PWD/gateway.hosted.config.json:/config/gateway.config.json:ro" \
#     vengtoo/mcp-gateway

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only production deps (@modelcontextprotocol/sdk).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run unprivileged.
RUN addgroup -S vengtoo && adduser -S -G vengtoo vengtoo
USER vengtoo

# Default to HTTP hosting mode, bound to all interfaces (container). Non-loopback
# binding REQUIRES caller auth (VENGTOO_GATEWAY_HTTP_CALLERS or http.callers) —
# the gateway refuses to start otherwise, by design.
ENV VENGTOO_GATEWAY_TRANSPORT=http \
    VENGTOO_GATEWAY_HOST=0.0.0.0 \
    VENGTOO_GATEWAY_PORT=8808

EXPOSE 8808
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--config", "/config/gateway.config.json"]
