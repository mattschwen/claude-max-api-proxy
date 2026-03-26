type PluginApi = any;
declare const claudeCodeCliPlugin: {
    id: string;
    name: string;
    description: string;
    configSchema: {
        type: "object";
        properties: Record<string, never>;
        additionalProperties: boolean;
    };
    register(api: PluginApi): void;
};
export default claudeCodeCliPlugin;
export { startServer, stopServer, getServer } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
export { sessionManager } from "./session/manager.js";
export { conversationStore } from "./store/conversation.js";
export { subprocessPool } from "./subprocess/pool.js";
//# sourceMappingURL=index.d.ts.map