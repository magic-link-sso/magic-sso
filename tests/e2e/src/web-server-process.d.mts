export interface WebServerSpawnOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: true;
    stdio: ['ignore', 'pipe', 'pipe'];
}

export function createWebServerSpawnOptions(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
}): WebServerSpawnOptions;
