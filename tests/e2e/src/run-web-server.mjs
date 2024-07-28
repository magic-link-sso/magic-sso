import { spawn } from 'node:child_process';
import { createWebServerSpawnOptions } from './web-server-process.mjs';

const maxBufferedChars = 120_000;
const ansiPattern = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'gu');
const quietPatterns = [
    /Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\./u,
    /Use `node --trace-warnings \.\.\.` to show where the warning was created/u,
    /WARN \[plugin nuxt:module-preload-polyfill\] Sourcemap is likely to be incorrect/u,
];

function readRequiredEnv(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${name} must be set.`);
    }

    return value;
}

function stripAnsi(value) {
    return value.replace(ansiPattern, '');
}

function shouldIgnoreLine(line) {
    const normalizedLine = stripAnsi(line);
    return quietPatterns.some((pattern) => pattern.test(normalizedLine));
}

function createOutputBuffer() {
    let bufferedOutput = '';

    return {
        append(line) {
            if (line.length === 0 || shouldIgnoreLine(line)) {
                return;
            }

            bufferedOutput += line.endsWith('\n') ? line : `${line}\n`;
            if (bufferedOutput.length <= maxBufferedChars) {
                return;
            }

            bufferedOutput = `[quiet-web-server] Output truncated to the last ${maxBufferedChars} characters.\n${bufferedOutput.slice(-maxBufferedChars)}`;
        },
        flush() {
            return bufferedOutput;
        },
    };
}

function createLineCollector(onLine) {
    let remainder = '';

    return {
        push(chunk) {
            remainder += chunk.toString('utf8');
            const lines = remainder.split(/\r?\n/u);
            remainder = lines.pop() ?? '';

            for (const line of lines) {
                onLine(line);
            }
        },
        flush() {
            if (remainder.length > 0) {
                onLine(remainder);
                remainder = '';
            }
        },
    };
}

const command = readRequiredEnv('WEB_SERVER_COMMAND');
const outputBuffer = createOutputBuffer();
let isShuttingDown = false;

const child = spawn(
    command,
    createWebServerSpawnOptions({
        cwd: process.cwd(),
        env: process.env,
    }),
);

const stdoutCollector = createLineCollector((line) => {
    outputBuffer.append(line);
});
const stderrCollector = createLineCollector((line) => {
    outputBuffer.append(line);
});

child.stdout.on('data', (chunk) => {
    stdoutCollector.push(chunk);
});
child.stderr.on('data', (chunk) => {
    stderrCollector.push(chunk);
});

child.on('error', (error) => {
    process.stderr.write(`[quiet-web-server] Failed to start command: ${command}\n`);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});

function forwardSignal(signal) {
    isShuttingDown = true;
    child.kill(signal);
}

process.on('SIGINT', () => {
    forwardSignal('SIGINT');
});
process.on('SIGTERM', () => {
    forwardSignal('SIGTERM');
});

child.on('close', (code, signal) => {
    stdoutCollector.flush();
    stderrCollector.flush();

    if (isShuttingDown) {
        process.exit(0);
    }

    if (code === 0 && signal === null) {
        process.exit(0);
    }

    process.stderr.write(`[quiet-web-server] Command failed: ${command}\n`);
    const bufferedOutput = outputBuffer.flush();
    if (bufferedOutput.length > 0) {
        process.stderr.write(bufferedOutput);
    }

    if (signal !== null) {
        process.stderr.write(`[quiet-web-server] Process exited after signal ${signal}.\n`);
        process.exit(1);
    }

    process.exit(code ?? 1);
});
