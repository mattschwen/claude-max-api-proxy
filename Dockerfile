FROM node:22-slim

# Install git + gh CLI + Claude CLI.
# gh is used by subprocesses spawned through this proxy (claude --print, etc.)
# that need to commit + push as the user authenticated on the host. Config
# and credential state are mounted in at runtime (/home/node/.config/gh and
# /home/node/.gitconfig) so the container never ships credentials itself.
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
RUN npm run build && npm prune --omit=dev

# Writable data directory for SQLite DB and session state.
# chmod 777 so it works regardless of the runtime UID (set via docker-compose `user:`).
RUN mkdir -p /data && chmod 777 /data
VOLUME /data

# Run as non-root (required: Claude CLI refuses --dangerously-skip-permissions as root)
USER node

EXPOSE 3456

CMD ["node", "dist/server/standalone.js"]
