// SPDX-License-Identifier: MIT
/** @param {string} value @returns {string} */
function escapeHtml(value) {
    return value.replace(
        /[&<>"']/gu,
        (character) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[character],
    );
}

/** @param {string} text @returns {string} */
function linkedText(text) {
    return text
        .split(/(https?:\/\/[^\s<>"']+)/gu)
        .map((part) => {
            const escaped = escapeHtml(part);
            return /^https?:\/\//u.test(part)
                ? `<a href="${escaped}" rel="noreferrer">${escaped}</a>`
                : escaped;
        })
        .join('');
}

/** @param {{subject: string; to: string[]; text: string}[]} messages @returns {string} */
export function renderMailbox(messages) {
    const items = [...messages]
        .reverse()
        .map(
            (message) => `<article>
        <h2>${escapeHtml(message.subject)}</h2><p>To: ${escapeHtml(message.to.join(', '))}</p>
        <pre>${linkedText(message.text)}</pre></article>`,
        )
        .join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Magic Link SSO development inbox</title>
        <style>body{font:16px system-ui;max-width:64rem;margin:2rem auto;padding:0 1rem}article{border-top:1px solid #888;margin-top:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
        <h1>Magic Link SSO development inbox</h1><p><a href="/">Refresh inbox</a> · <a href="/messages">JSON</a></p>
        ${items || '<p>No messages yet. Sign in to send a magic link and OTP here.</p>'}</html>`;
}
