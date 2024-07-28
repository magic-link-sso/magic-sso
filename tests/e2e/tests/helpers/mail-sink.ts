import type { APIRequestContext } from '@playwright/test';

export interface SinkMessage {
    html: string;
    id: string;
    subject: string;
    text: string;
    to: string[];
}

interface SinkMessagesResponse {
    messages: SinkMessage[];
}

export interface WaitForMagicLinkOptions {
    readonly callbackUrlPrefix: string;
    readonly recipient: string;
    readonly timeoutMs?: number;
}

const mailSinkBaseUrl = 'http://localhost:43126';

export async function clearMailbox(request: APIRequestContext): Promise<void> {
    const response = await request.delete(`${mailSinkBaseUrl}/messages`);
    if (!response.ok()) {
        throw new Error(`Failed to clear mailbox: ${response.status()} ${await response.text()}`);
    }
}

export async function listMessages(request: APIRequestContext): Promise<SinkMessage[]> {
    const response = await request.get(`${mailSinkBaseUrl}/messages`);
    if (!response.ok()) {
        throw new Error(`Failed to list messages: ${response.status()} ${await response.text()}`);
    }

    const payload = parseSinkMessagesResponse(await response.json());
    return payload.messages;
}

export async function waitForMagicLink(
    request: APIRequestContext,
    options: WaitForMagicLinkOptions,
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const messages = await listMessages(request);
        const matchingMessage = messages.find((message) =>
            message.to.some((address) => address.toLowerCase() === options.recipient.toLowerCase()),
        );

        if (matchingMessage) {
            return extractMagicLink(matchingMessage, options.callbackUrlPrefix);
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 250);
        });
    }

    throw new Error(`Timed out waiting for a magic link for ${options.recipient}.`);
}

export async function expectNoMessagesForRecipient(
    request: APIRequestContext,
    recipient: string,
    waitMs = 1_000,
): Promise<void> {
    await new Promise((resolve) => {
        setTimeout(resolve, waitMs);
    });

    const messages = await listMessages(request);
    const matchingMessage = messages.find((message) =>
        message.to.some((address) => address.toLowerCase() === recipient.toLowerCase()),
    );

    if (matchingMessage) {
        throw new Error(
            `Expected no messages for ${recipient}, but found message ${matchingMessage.id}.`,
        );
    }
}

function extractMagicLink(message: SinkMessage, callbackUrlPrefix: string): string {
    const bodies = [message.text, message.html];
    const magicLinkPattern = new RegExp(`${escapeRegExp(callbackUrlPrefix)}[^\\s"'<>)]*`, 'u');

    for (const body of bodies) {
        const match = body.match(magicLinkPattern);
        if (match?.[0]) {
            return match[0];
        }
    }

    throw new Error(`No magic link found in email message ${message.id}.`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseSinkMessagesResponse(value: unknown): SinkMessagesResponse {
    if (typeof value !== 'object' || value === null || !('messages' in value)) {
        throw new Error('Mail sink returned an invalid response payload.');
    }

    const { messages } = value;
    if (!Array.isArray(messages)) {
        throw new Error('Mail sink returned an invalid messages list.');
    }

    const parsedMessages = messages.map(parseSinkMessage);
    return {
        messages: parsedMessages,
    };
}

function parseSinkMessage(value: unknown): SinkMessage {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Mail sink returned an invalid message.');
    }
    if (
        !('html' in value) ||
        !('id' in value) ||
        !('subject' in value) ||
        !('text' in value) ||
        !('to' in value)
    ) {
        throw new Error('Mail sink returned a message with missing fields.');
    }

    const { html, id, subject, text, to } = value;
    if (
        typeof html !== 'string' ||
        typeof id !== 'string' ||
        typeof subject !== 'string' ||
        typeof text !== 'string' ||
        !Array.isArray(to) ||
        to.some((address) => typeof address !== 'string')
    ) {
        throw new Error('Mail sink returned a message with invalid field types.');
    }

    return {
        html,
        id,
        subject,
        text,
        to,
    };
}
