import { timingSafeEqual } from 'node:crypto';

export interface ReadCookieValueOptions {
    lastMatch?: boolean;
}

function decodeCookieValue(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function readCookieValue(
    cookieHeader: string | null | undefined,
    name: string,
    options: ReadCookieValueOptions = {},
): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${name}=`;
    let matchedValue: string | undefined;
    for (const item of cookieHeader.split(';')) {
        const trimmedItem = item.trim();
        if (!trimmedItem.startsWith(prefix)) {
            continue;
        }

        const decodedValue = decodeCookieValue(trimmedItem.slice(prefix.length));
        if (options.lastMatch === true) {
            matchedValue = decodedValue;
            continue;
        }

        return decodedValue;
    }

    return matchedValue;
}

export function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
