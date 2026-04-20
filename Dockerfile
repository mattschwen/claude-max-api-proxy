FROM node:22-slim

# Install git + gh CLI + Claude CLI.
# gh enables optional GitHub workflows inside containerized Claude Code tasks.
# The proxy itself does not require mounted GitHub credentials; if you do mount
# them, keep config and credential state external to the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@latest

# System-wide git config: wire gh as the credential helper for HTTPS GitHub
# pushes. Keeping it in /etc/gitconfig means the user's mounted ~/.gitconfig
# only needs user.name + user.email; credential handling works out of the
# box. Safe-directory for /opt/repos so git doesn't balk at mounted paths
# owned by a different uid on the host.
RUN git config --system credential.https://github.com.helper "" \
 && git config --system --add credential.https://github.com.helper "!gh auth git-credential" \
 && git config --system credential.https://gist.github.com.helper "" \
 && git config --system --add credential.https://gist.github.com.helper "!gh auth git-credential" \
 && git config --system --add safe.directory '*'

WORKDIR /app

# Copy package files and install all deps (including devDependencies for build)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
COPY assets/ assets/
RUN npm run build && npm prune --omit=dev

# Writable data directory for SQLite DB and session state.
# chmod 777 so it works regardless of the runtime UID (set via docker-compose `user:`).
RUN mkdir -p /data && chmod 777 /data
VOLUME /data

# Run as non-root (required: Claude CLI refuses --dangerously-skip-permissions as root)
USER node

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/health').then((res) => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "dist/server/standalone.js"]
