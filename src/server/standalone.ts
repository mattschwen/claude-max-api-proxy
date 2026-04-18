#!/usr/bin/env node
/**
 * Standalone CLI entrypoint for claude-max-api-proxy.
 *
 * Starts the local OpenAI-compatible proxy without any host application.
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */
import { startServer, stopServer, getServer } from "./index.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";
import { subprocessRegistry } from "../subprocess/manager.js";
import { sessionManager } from "../session/manager.js";
import { log } from "../logger.js";
import { modelAvailability } from "../model-availability.js";
import { runtimeConfig } from "../config.js";

const DEFAULT_PORT = 3456;
const SHUTDOWN_GRACE_MS = 30000;

async function main(): Promise<void> {
  console.log("Claude Max API Proxy");
  console.log("====================\n");

  const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

  console.log("Checking authentication...");
  const authCheck = await verifyAuth();
  if (!authCheck.ok) {
    console.error(`Error: ${authCheck.error}`);
    console.error("Please run: claude auth login");
    process.exit(1);
  }
  console.log("  Authentication: OK\n");

  console.log("Checking model access...");
  console.log(`Queue policy: ${runtimeConfig.sameConversationPolicy}`);
  if (runtimeConfig.debugQueues) {
    console.log("Queue debug logging: enabled");
  }
  if (runtimeConfig.defaultAgent) {
    console.log(`Default agent: ${runtimeConfig.defaultAgent}`);
  }
  const availability = await modelAvailability.getSnapshot(true);
  if (availability.available.length === 0) {
    console.warn("  No accessible models detected");
    if (availability.unavailable[0]) {
      console.warn(`  Reason: ${availability.unavailable[0].error.message}`);
    }
    console.warn(
      "  The server will start, but /v1/models will be empty and chat requests will fail until model access is restored.\n",
    );
  } else {
    console.log(
      `  Models: ${availability.available.map((model) => model.id).join(", ")}\n`,
    );
  }

  try {
    const host = process.env.HOST || "127.0.0.1";
    await startServer({ port, host });
    log("server.start", { port });
    console.log("\nServer ready. Test with:");
    console.log(
      `  curl -X POST http://127.0.0.1:${port}/v1/chat/completions \\`,
    );
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(
      `    -d '{"model": "sonnet", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    );
    console.log("\nPress Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log("server.shutdown", { signal });
    console.log(
      `\n[Shutdown] Received ${signal}, starting graceful shutdown...`,
    );

    // 1. Stop accepting new connections
    const server = getServer();
    if (server) {
      server.close(() => {
        console.log("[Shutdown] Server closed to new connections");
      });
    }

    // 2. Wait for in-flight requests (grace period)
    const activeCount = subprocessRegistry.size;
    if (activeCount > 0) {
      console.log(
        `[Shutdown] Waiting up to ${SHUTDOWN_GRACE_MS / 1000}s for ${activeCount} in-flight requests...`,
      );
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (subprocessRegistry.size === 0) {
            clearInterval(checkInterval);
            console.log("[Shutdown] All in-flight requests completed");
            resolve();
          }
        }, 500);

        setTimeout(() => {
          clearInterval(checkInterval);
          if (subprocessRegistry.size > 0) {
            console.log(
              `[Shutdown] Grace period expired, ${subprocessRegistry.size} requests still active`,
            );
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
      });
    }

    // 3. Kill remaining subprocesses
    if (subprocessRegistry.size > 0) {
      console.log(
        `[Shutdown] Killing ${subprocessRegistry.size} remaining subprocesses`,
      );
      subprocessRegistry.killAll();
    }

    // 4. Save sessions
    if (sessionManager["dirty"]) {
      console.log("[Shutdown] Saving sessions...");
      sessionManager.saveSync();
    }

    // 5. Stop server and exit
    try {
      await stopServer();
    } catch {
      /* already closing */
    }

    console.log("[Shutdown] Goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
