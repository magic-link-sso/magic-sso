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
// Keep fixed listeners below Linux's ephemeral range (32768–60999), including
// the HTTPS upstreams at port + 1000, so outgoing connections cannot claim them.
const ports: Record<BrowserSsoFixtureRole, number> = {
    issuer: 25000,
    'gate-a': 25001,
    'gate-b': 25002,
    next: 25004,
    nuxt: 25005,
    django: 25006,
    angular: 25007,
    fastify: 25008,
    compat: 25009,
};
export const browserSsoUpstreamPort = 25003;
export const browserSsoProxyUrl = 'http://127.0.0.1:25100';
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
