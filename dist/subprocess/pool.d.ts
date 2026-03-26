declare class SubprocessPool {
    private warmedAt;
    private warming;
    warm(): Promise<void>;
    private spawnQuick;
    private warmDeep;
    isWarm(): boolean;
    getStatus(): {
        warmedAt: string | null;
        isWarm: boolean;
        poolSize: number;
        warming: boolean;
    };
}
export declare const subprocessPool: SubprocessPool;
export {};
//# sourceMappingURL=pool.d.ts.map