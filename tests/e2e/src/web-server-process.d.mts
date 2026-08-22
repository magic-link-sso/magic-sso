export interface WebServerSpawnOptions {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    shell: true;
    stdio: ['ignore', 'pipe', 'pipe'];
}

export function createWebServerSpawnOptions(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
}): WebServerSpawnOptions;

export function getWebServerProcessSignalTarget(pid: number, platform?: NodeJS.Platform): number;
