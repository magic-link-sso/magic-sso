// SPDX-License-Identifier: MIT
export type BrowserSsoFixtureRole =
    | 'issuer'
    | 'gate-a'
    | 'gate-b'
    | 'next'
    | 'nuxt'
    | 'django'
    | 'angular'
    | 'fastify'
    | 'compat';
const ports: Record<BrowserSsoFixtureRole, number> = {
    issuer: 45000,
    'gate-a': 45001,
    'gate-b': 45002,
    next: 45004,
    nuxt: 45005,
    django: 45006,
    angular: 45007,
    fastify: 45008,
    compat: 45009,
};
const hosts: Record<BrowserSsoFixtureRole, string> = {
    issuer: 'sso.identity.test',
    'gate-a': 'app.alpha.test',
    'gate-b': 'app.beta.test',
    next: 'app.next.test',
    nuxt: 'app.nuxt.test',
    django: 'app.django.test',
    angular: 'app.angular.test',
    fastify: 'app.fastify.test',
    compat: 'app.compat.test',
};
export const browserSsoHttps = process.env.MAGICSSO_E2E_SSO_HTTPS === 'true';
export const browserSsoTestHosts: readonly string[] = Object.values(hosts);
export const browserSsoTestPorts: readonly number[] = Object.values(ports);
export function browserSsoOrigin(role: BrowserSsoFixtureRole): string {
    const host = browserSsoHttps
        ? hosts[role]
        : role === 'issuer'
          ? '127.0.0.1'
          : role === 'gate-a'
            ? 'a.localhost'
            : role === 'gate-b'
              ? 'b.localhost'
              : `${role}.localhost`;
    return `${browserSsoHttps ? 'https' : 'http'}://${host}:${ports[role]}`;
}
export function browserSsoListenPort(role: BrowserSsoFixtureRole): number {
    return ports[role] + (browserSsoHttps ? 1000 : 0);
}
