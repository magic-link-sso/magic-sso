// SPDX-License-Identifier: MIT
import { Injector, REQUEST, runInInjectionContext } from '@angular/core';
import { Router, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { resolveMagicSsoConfig, type AuthPayload } from '@magic-link-sso/angular';
import { afterEach, expect, it, vi } from 'vitest';
import { MAGIC_SSO_CONFIG, MagicSsoSessionService, magicSsoAuthGuard } from './magic-sso';

// These tokens are supplied as values; no DOM or HTTP implementation is needed to exercise the guard.
vi.mock('@angular/common/http', () => ({ HttpClient: class HttpClient {} }));
vi.mock('@angular/router', () => ({ Router: class Router {} }));

afterEach(() => vi.unstubAllGlobals());

async function guard(input: {
    mode: 'off' | 'required';
    request: Request | null;
    auth: AuthPayload | null;
}): Promise<{ result: unknown; parseUrl: ReturnType<typeof vi.fn> }> {
    const parseUrl = vi.fn((url: string) => ({ url }));
    const injector = Injector.create({
        providers: [
            { provide: REQUEST, useValue: input.request },
            { provide: Router, useValue: { parseUrl } },
            {
                provide: MagicSsoSessionService,
                useValue: { getAuth: async (): Promise<AuthPayload | null> => input.auth },
            },
            {
                provide: MAGIC_SSO_CONFIG,
                useValue: resolveMagicSsoConfig({
                    serverUrl: 'https://issuer.test',
                    publicOrigin: 'https://app.test',
                    jwtSecret: 'test-secret-01234567890123456789012',
                    browserSsoMode: input.mode,
                }),
            },
        ],
    });
    // The guard ignores the route snapshot; its only RouterStateSnapshot input is the requested URL.
    const route = {} as ActivatedRouteSnapshot;
    // Use only the URL the guard reads, without constructing an unrelated router tree.
    const state = { url: '/protected?tag=one&tag=two' } as RouterStateSnapshot;
    return {
        result: await runInInjectionContext(injector, () => magicSsoAuthGuard(route, state)),
        parseUrl,
    };
}

it('allows an authenticated request without starting another navigation', async () => {
    const auth: AuthPayload = {
        email: 'owner@example.com',
        jti: 'test',
        scope: '*',
        siteId: 'app',
        aud: 'https://app.test',
        iss: 'https://issuer.test',
        iat: 1,
        exp: 9999999999,
    };
    const { result, parseUrl } = await guard({
        mode: 'required',
        request: new Request('https://app.test/protected'),
        auth,
    });
    expect(result).toBe(true);
    expect(parseUrl).not.toHaveBeenCalled();
});

it('refuses unauthenticated SSR rendering without browser navigation', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://app.test', assign });
    const { result } = await guard({
        mode: 'required',
        request: new Request('https://app.test/protected'),
        auth: null,
    });
    expect(result).toBe(false);
    expect(assign).not.toHaveBeenCalled();
});

it('starts a document navigation in the browser and preserves the original query', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://app.test', assign });
    const { result } = await guard({ mode: 'required', request: null, auth: null });
    expect(result).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
    const target: unknown = assign.mock.calls[0]?.[0];
    expect(typeof target).toBe('string');
    if (typeof target !== 'string') {
        throw new Error('Missing navigation');
    }
    const url = new URL(target, 'https://app.test');
    expect(url.pathname).toBe('/sso/start');
    expect(url.searchParams.get('returnUrl')).toBe('https://app.test/protected?tag=one&tag=two');
});

it('retains router navigation for legacy sign-in', async () => {
    const { result, parseUrl } = await guard({ mode: 'off', request: null, auth: null });
    expect(parseUrl).toHaveBeenCalledOnce();
    expect(result).toEqual({ url: expect.stringContaining('/login?') });
});
