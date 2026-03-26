import { EventEmitter } from "events";
import type { ClaudeCliMessage, ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
export interface SubprocessOptions {
    model: ClaudeModel;
    sessionId?: string;
    systemPrompt?: string;
    isResume?: boolean;
    cwd?: string;
    thinkingBudget?: number;
}
export interface SubprocessEvents {
    message: (msg: ClaudeCliMessage) => void;
    content_delta: (msg: ClaudeCliStreamEvent) => void;
    assistant: (msg: ClaudeCliAssistant) => void;
    result: (result: ClaudeCliResult) => void;
    error: (error: Error) => void;
    close: (code: number | null) => void;
    raw: (line: string) => void;
}
/**
 * Global subprocess registry for server-wide cleanup.
 * Tracks all active subprocesses so graceful shutdown can kill them all.
 */
declare class SubprocessRegistry {
    private active;
    register(subprocess: ClaudeSubprocess): void;
    unregister(subprocess: ClaudeSubprocess): void;
    killAll(): void;
    getActivePids(): number[];
    get size(): number;
}
export declare const subprocessRegistry: SubprocessRegistry;
export declare class ClaudeSubprocess extends EventEmitter {
    private process;
    private buffer;
    private killed;
    private escalationTimer;
    /**
     * Start the Claude CLI subprocess with the given prompt.
     * No timeout is set here — caller owns timeout behavior (Phase 1c).
     */
    start(prompt: string, options: SubprocessOptions): Promise<void>;
    private buildArgs;
    private processBuffer;
    /**
     * Kill the subprocess with escalation: SIGTERM -> SIGKILL after 5s grace.
     */
    kill(): void;
    isRunning(): boolean;
    getPid(): number | null;
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export declare function verifyClaude(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}>;
/**
 * Check if Claude CLI is authenticated
 */
export declare function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
}>;
export {};
//# sourceMappingURL=manager.d.ts.map