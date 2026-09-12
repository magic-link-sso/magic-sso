// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

/**
 * Escape the five characters that change meaning inside HTML text nodes and
 * double- or single-quoted attribute values, so untrusted strings can be
 * interpolated into a server-rendered template.
 */
export function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
