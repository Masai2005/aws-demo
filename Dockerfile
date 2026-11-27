FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Runtime image (same base — Bun is both build and runtime)
FROM base AS final
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3456
# DB_FILE is set at runtime; default to /data/data.sqlite so EFS mount lands there
ENV DB_FILE=/data/data.sqlite

EXPOSE 3456

# /data is the EFS mount point for the SQLite file
VOLUME ["/data"]

CMD ["bun", "src/server.ts"]
