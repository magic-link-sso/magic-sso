export function createWebServerSpawnOptions({ cwd, env }) {
    return {
        cwd,
        // A separate process group lets the Playwright wrapper stop the shell
        // together with the pnpm and Node processes it starts.
        detached: process.platform !== 'win32',
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    };
}

export function getWebServerProcessSignalTarget(pid, platform = process.platform) {
    return platform === 'win32' ? pid : -pid;
}
