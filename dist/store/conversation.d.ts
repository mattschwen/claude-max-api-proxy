interface MetricParams {
    conversationId?: string;
    durationMs?: number;
    success?: boolean;
    error?: string;
    clientDisconnected?: boolean;
}
declare class ConversationStore {
    private db;
    init(): void;
    ensureConversation(conversationId: string, model?: string, sessionId?: string): void;
    addMessage(conversationId: string, role: string, content: string): void;
    getMessages(conversationId: string): Array<{
        role: string;
        content: string;
        created_at: number;
    }>;
    getConversation(conversationId: string): Record<string, unknown> | undefined;
    recordMetric(event: string, params?: MetricParams): void;
    getHealthMetrics(minutesBack?: number): Array<Record<string, unknown>>;
    getRecentErrors(limit?: number): Array<Record<string, unknown>>;
    cleanup(daysOld?: number): number;
    getStats(): {
        conversations: number;
        messages: number;
        metrics: number;
    };
}
export declare const conversationStore: ConversationStore;
export {};
//# sourceMappingURL=conversation.d.ts.map