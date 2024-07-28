export function createWebServerSpawnOptions({ cwd, env }) {
    return {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    };
}
