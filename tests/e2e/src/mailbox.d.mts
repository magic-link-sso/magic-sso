// SPDX-License-Identifier: MIT
export function renderMailbox(
    messages: readonly { subject: string; to: readonly string[]; text: string }[],
): string;
