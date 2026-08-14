// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export class MagicSsoConfigurationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'MagicSsoConfigurationError';
    }
}
