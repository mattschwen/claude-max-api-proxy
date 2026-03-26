/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for integration with OpenClaw/Clawdbot.
 *
 * CONCURRENCY MODEL: Queue-and-Serialize per conversation.
 * - Each conversation gets a FIFO queue
 * - Requests for the same conversation are processed sequentially
 * - Different conversations run fully in parallel
 * - No request is ever silently killed — every request gets a response
 *
 * Reliability improvements:
 * - Phase 1a: Activity-based stall detection (resets on each content_delta)
 * - Phase 2a: Extracted runStreamingSubprocess (single event-handler wiring)
 * - Phase 2b: Cleanup safety (Set-based, run-once, try/catch each)
 * - Phase 3a: Per-request queue timeout (absolute, with finally for processQueue)
 * - Phase 4a: Structured logging
 * - Phase 4b: Enhanced health endpoint
 */
import type { Request, Response } from "express";
export declare function handleChatCompletions(req: Request, res: Response): Promise<void>;
export declare function handleModels(_req: Request, res: Response): void;
export declare function handleHealth(_req: Request, res: Response): void;
//# sourceMappingURL=routes.d.ts.map