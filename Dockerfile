FROM node:22-slim

# Install git and Claude CLI
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files and install all deps (including devDependencies for build)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
RUN npm run build && npm prune --omit=dev

# Writable data directory for SQLite DB and session state.
# chmod 777 so it works regardless of the runtime UID (set via docker-compose `user:`).
RUN mkdir -p /data && chmod 777 /data
VOLUME /data

# Run as non-root (required: Claude CLI refuses --dangerously-skip-permissions as root)
USER node

EXPOSE 3456

CMD ["node", "dist/server/standalone.js"]
