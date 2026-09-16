// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { createError, getRequestURL, readBody } from 'h3';
import {
    readValidSignInBody,
    requestSignIn,
    type SignInRequestBody,
    type SignInResult,
} from './signin';

export default defineEventHandler(async (event): Promise<SignInResult> => {
    const body = readValidSignInBody(await readBody<SignInRequestBody>(event));
    if (body === null) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Invalid sign-in request payload.',
        });
    }

    return requestSignIn(body, useRuntimeConfig(event).magicSso, getRequestURL(event).origin);
});
