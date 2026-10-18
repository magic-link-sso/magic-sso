// SPDX-License-Identifier: MIT
// Test-process DNS only. Never edits OS resolver or trust settings.
const dns = require('node:dns');
const originalLookup = dns.lookup;
const hosts = new Set([
    'sso.identity.test',
    'app.alpha.test',
    'app.beta.test',
    'app.next.test',
    'app.nuxt.test',
    'app.django.test',
    'app.angular.test',
    'app.fastify.test',
    'app.compat.test',
]);
dns.lookup = function lookup(host, options, callback) {
    return originalLookup.call(dns, hosts.has(host) ? '127.0.0.1' : host, options, callback);
};
