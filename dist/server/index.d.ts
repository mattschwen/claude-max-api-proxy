import { type Server } from "http";
import "../subprocess/pool.js";
import "../store/conversation.js";
export interface ServerConfig {
    port: number;
    host?: string;
}
export declare function startServer(config: ServerConfig): Promise<Server>;
export declare function stopServer(): Promise<void>;
export declare function getServer(): Server | null;
//# sourceMappingURL=index.d.ts.map