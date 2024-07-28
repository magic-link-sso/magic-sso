import { createServer } from 'node:http';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

function readEnvNumber(name, fallback) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
        return fallback;
    }

    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }

    return parsedValue;
}

function readEnvString(name, fallback) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
        return fallback;
    }

    return value;
}

function writeJson(response, statusCode, body) {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
}

const mailbox = [];
let nextMessageId = 1;

const smtpHost = readEnvString('MAIL_SINK_SMTP_HOST', '127.0.0.1');
const smtpPort = readEnvNumber('MAIL_SINK_SMTP_PORT', 14625);
const httpHost = readEnvString('MAIL_SINK_HTTP_HOST', '127.0.0.1');
const httpPort = readEnvNumber('MAIL_SINK_HTTP_PORT', 4025);
const smtpUser = readEnvString('MAIL_SINK_SMTP_USER', 'test-user');
const smtpPass = readEnvString('MAIL_SINK_SMTP_PASS', 'test-password');

const smtpServer = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth(authentication, _session, callback) {
        if (authentication.username === smtpUser && authentication.password === smtpPass) {
            callback(null, { user: authentication.username });
            return;
        }

        callback(new Error('Invalid username or password'));
    },
    onData(stream, session, callback) {
        const chunks = [];

        stream.on('data', (chunk) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });

        stream.once('error', (error) => {
            callback(error);
        });

        stream.once('end', async () => {
            try {
                const parsedMessage = await simpleParser(Buffer.concat(chunks));
                const recipients = session.envelope.rcptTo.map((recipient) => recipient.address);
                const parsedHtml = parsedMessage.html;
                const html =
                    typeof parsedHtml === 'string'
                        ? parsedHtml
                        : parsedHtml === false ||
                            parsedHtml === null ||
                            typeof parsedHtml === 'undefined'
                          ? ''
                          : parsedHtml.toString();

                mailbox.push({
                    html,
                    id: String(nextMessageId),
                    subject: parsedMessage.subject ?? '',
                    text: parsedMessage.text ?? '',
                    to: recipients,
                });
                nextMessageId += 1;
                callback();
            } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        });
    },
});

const httpServer = createServer((request, response) => {
    if (typeof request.url !== 'string') {
        writeJson(response, 400, { message: 'Missing request URL' });
        return;
    }

    const requestUrl = new URL(request.url, `http://${httpHost}:${httpPort}`);
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        writeJson(response, 200, { status: 'ok' });
        return;
    }

    if (requestUrl.pathname !== '/messages') {
        writeJson(response, 404, { message: 'Not found' });
        return;
    }

    if (request.method === 'DELETE') {
        mailbox.length = 0;
        nextMessageId = 1;
        writeJson(response, 200, { cleared: true });
        return;
    }

    if (request.method === 'GET') {
        writeJson(response, 200, { messages: mailbox });
        return;
    }

    writeJson(response, 405, { message: 'Method not allowed' });
});

function shutdown(signal) {
    console.info(`Shutting down SMTP sink after ${signal}`);

    void Promise.allSettled([
        new Promise((resolveClose, rejectClose) => {
            smtpServer.close((error) => {
                if (error) {
                    rejectClose(error);
                    return;
                }

                resolveClose();
            });
        }),
        new Promise((resolveClose, rejectClose) => {
            httpServer.close((error) => {
                if (error) {
                    rejectClose(error);
                    return;
                }

                resolveClose();
            });
        }),
    ]).finally(() => {
        process.exit(0);
    });
}

process.on('SIGINT', () => {
    shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

smtpServer.listen(smtpPort, smtpHost, () => {
    console.info(`SMTP sink listening on smtp://${smtpHost}:${smtpPort}`);
});

httpServer.listen(httpPort, httpHost, () => {
    console.info(`SMTP sink API listening on http://${httpHost}:${httpPort}`);
});
