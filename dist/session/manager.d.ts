export interface SessionMapping {
    clawdbotId: string;
    claudeSessionId: string;
    createdAt: number;
    lastUsedAt: number;
    model: string;
    taskCount?: number;
    /** Consecutive resume failure count */
    resumeFailures?: number;
}
declare class SessionManager {
    private sessions;
    private loaded;
    private dirty;
    private saveTimer;
    load(): Promise<void>;
    saveSync(): void;
    private scheduleSave;
    save(): Promise<void>;
    /**
     * Get or create a Claude session ID for a Clawdbot conversation.
     * Returns { sessionId, isResume } so callers know whether to use --resume.
     */
    getOrCreate(clawdbotId: string, model?: string): {
        sessionId: string;
        isResume: boolean;
    };
    get(clawdbotId: string): SessionMapping | undefined;
    delete(clawdbotId: string): boolean;
    /**
     * Mark a session as having a resume failure.
     * After MAX_RESUME_FAILURES consecutive failures, auto-invalidate the session.
     */
    markFailed(clawdbotId: string): void;
    /**
     * Reset failure count on successful resume.
     */
    markSuccess(clawdbotId: string): void;
    /**
     * Get resume failure stats for health endpoint.
     */
    getFailureStats(): {
        totalFailures: number;
        sessionsWithFailures: number;
    };
    cleanup(): number;
    getAll(): SessionMapping[];
    get size(): number;
}
export declare const sessionManager: SessionManager;
export {};
//# sourceMappingURL=manager.d.ts.map