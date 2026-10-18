// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

/** @type {import('next').NextConfig} */
const nextConfig = {
    logging: {
        serverFunctions: false,
        incomingRequests: { ignore: [/^\/sso\//, /^\/verify-email(?:\?|$)/] },
    },
};

export default nextConfig;
