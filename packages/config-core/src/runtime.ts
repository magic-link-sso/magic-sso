import { timingSafeEqual } from 'node:crypto';
export {
    parseBrowserSsoCapabilities,
    hashBrowserSsoToken,
    createBrowserSsoBootstrapReceipt,
    isBrowserSsoDocumentNavigation,
    escapeHtml,
    readCookieValue,
    type ReadCookieValueOptions,
} from '@magic-link-sso/core';

/** Shared response handling for existing server-side sign-in and Gate callers. */
export async function readResponsePayload(response: Response): Promise<unknown> {
    return response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
}

export function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}
