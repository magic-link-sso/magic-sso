export interface ProcessLike {
    env: NodeJS.ProcessEnv;
    on(event: NodeJS.Signals, listener: () => void): ProcessLike;
    removeListener(event: NodeJS.Signals, listener: () => void): ProcessLike;
}

export interface ChildLike {
    kill(signal?: NodeJS.Signals): boolean;
    once(event: 'error', listener: (error: Error) => void): unknown;
    once(
        event: 'exit',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
}

export interface SyncResult {
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
}

export interface RunDevOptions {
    processObject?: ProcessLike;
    spawnFn?: (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; stdio: 'inherit' },
    ) => ChildLike;
    spawnSyncFn?: (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; stdio: 'inherit' },
    ) => SyncResult;
}

export function runDev(options?: RunDevOptions): Promise<number>;
