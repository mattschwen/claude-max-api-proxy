/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */
import express from "express";
import { createServer, type Server } from "http";
import type { Socket } from "net";
import {
  handleChatCompletions,
  handleModels,
  handleHealth,
  handleGetThinkingBudget,
  handleSetThinkingBudget,
} from "./routes.js";
import { runtimeConfig } from "../config.js";
import "../subprocess/pool.js";
import "../store/conversation.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

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

  app.options("*", (_req, res) => {
    res.sendStatus(200);
  });

  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);
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
      console.log(
        `[Server] Claude Code CLI provider running at http://${host}:${port}`,
      );
      console.log(
        `[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`,
      );
      resolve(serverInstance!);
    });
  });
}

export async function stopServer(): Promise<void> {
  if (!serverInstance) return;
  return new Promise<void>((resolve, reject) => {
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
