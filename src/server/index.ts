/**
 * Express HTTP server
 *
 * Provides the standalone OpenAI-compatible API surface.
 */
import express from "express";
import { createServer, type Server } from "http";
import type { Socket } from "net";
import path from "node:path";
import { networkInterfaces } from "os";
import {
  handleAgentDetails,
  handleAgents,
  handleChatCompletions,
  handleCapabilities,
  handleMetrics,
  handleModels,
  handleResponses,
  handleHealth,
  handleGetThinkingBudget,
  handleSetThinkingBudget,
} from "./routes.js";
import {
  handleOpsConversation,
  handleOpsDashboard,
  handleOpsSnapshot,
  handleOpsStream,
} from "./ops-dashboard.js";
import { handleLauncher } from "./launcher.js";
import { runtimeConfig } from "../config.js";
import { httpMetricsMiddleware } from "../observability/metrics.js";
import {
  startProactiveRefresh,
  stopProactiveRefresh,
} from "../auth/proactive-refresh.js";
import "../subprocess/pool.js";
import "../store/conversation.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

function getAdvertisedHosts(host: string): string[] {
  if (host !== "0.0.0.0" && host !== "::" && host !== "::0") {
    return [host];
  }

  const advertised = new Set<string>(["127.0.0.1", "localhost"]);
  const interfaces = networkInterfaces();

  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (
        record.family === "IPv4" &&
        !record.internal &&
        record.address &&
        !record.address.startsWith("169.254.")
      ) {
        advertised.add(record.address);
      }
    }
  }

  return Array.from(advertised);
}

function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use((req, res, next) => {
    const isOpsRoute =
      req.path === "/" ||
      req.path === "/launch" ||
      req.path === "/dashboard" ||
      req.path.startsWith("/dashboard/") ||
      req.path.startsWith("/ops") ||
      req.path.startsWith("/assets/");
    if (isOpsRoute) {
      next();
      return;
    }
    httpMetricsMiddleware(req, res, next);
  });

  app.use((req, _res, next) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Thinking-Budget",
    );
    next();
  });

  app.options(/.*/, (_req, res) => {
    res.sendStatus(200);
  });

  app.use("/assets", express.static(path.join(process.cwd(), "assets")));
  app.get("/", handleOpsDashboard);
  app.get("/launch", handleLauncher);
  app.get("/ops", handleOpsDashboard);
  app.get("/dashboard", handleOpsDashboard);
  app.get("/ops/legacy", (_req, res) => {
    res.redirect(302, "/ops");
  });
  app.get("/dashboard/legacy", (_req, res) => {
    res.redirect(302, "/dashboard");
  });
  app.get("/ops/snapshot", handleOpsSnapshot);
  app.get("/ops/stream", handleOpsStream);
  app.get("/ops/conversations/:conversationId", handleOpsConversation);
  app.get("/health", handleHealth);
  app.get("/metrics", handleMetrics);
  app.get("/v1/models", handleModels);
  app.get("/v1/capabilities", handleCapabilities);
  app.get("/v1/agents", handleAgents);
  app.get("/v1/agents/:agentId", handleAgentDetails);
  app.post("/v1/chat/completions", handleChatCompletions);
  app.post("/v1/responses", handleResponses);
  app.post("/v1/agents/:agentId/chat/completions", handleChatCompletions);
  app.post("/v1/agents/:agentId/responses", handleResponses);
  if (runtimeConfig.enableAdminApi) {
    app.get("/admin/thinking-budget", handleGetThinkingBudget);
    app.post("/admin/thinking-budget", handleSetThinkingBudget);
    app.put("/admin/thinking-budget", handleSetThinkingBudget);
  }

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[Server Error]:", err.message);
      res.status(500).json({
        error: {
          message: err.message,
          type: "server_error",
          code: null,
        },
      });
    },
  );

  return app;
}

export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;
  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }
  const app = createApp();
  return new Promise<Server>((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("connection", (socket: Socket) => {
      socket.setNoDelay(true);
    });

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      const advertisedHosts = getAdvertisedHosts(host);
      console.log("[Server] Native command deck:");
      for (const advertisedHost of advertisedHosts) {
        console.log(`  http://${advertisedHost}:${port}`);
      }
      console.log("[Server] Launch deck:");
      for (const advertisedHost of advertisedHosts) {
        console.log(`  http://${advertisedHost}:${port}/launch`);
      }
      console.log("[Server] OpenAI-compatible endpoints:");
      for (const advertisedHost of advertisedHosts) {
        console.log(`  http://${advertisedHost}:${port}/v1/chat/completions`);
      }
      console.log("[Server] Dashboard alias:");
      for (const advertisedHost of advertisedHosts) {
        console.log(`  http://${advertisedHost}:${port}/ops`);
      }
      // Defense-in-depth against refresh_token rotation races: proactively
      // drive a token refresh when the access_token is approaching expiry
      // during an otherwise-quiet interval. Only started from startServer
      // so unit tests (which never call startServer) don't kick this off.
      if (process.env.NODE_ENV !== "test") {
        startProactiveRefresh();
      }
      resolve(serverInstance!);
    });
  });
}

export async function stopServer(): Promise<void> {
  if (!serverInstance) return;
  return new Promise<void>((resolve, reject) => {
    stopProactiveRefresh();
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

export function getServer(): Server | null {
  return serverInstance;
}
