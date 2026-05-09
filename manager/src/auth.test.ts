// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
    authenticateApiRequest,
    authenticateGateRequest,
    authenticateManagerRequest,
    extractBearerToken,
} from './auth.js';
import { type ManagerRuntimeSettings } from './settings.js';

function createBearerSettings(): ManagerRuntimeSettings {
    return {
        configFilePath: '/tmp/manager.toml',
        managedSiteIds: ['client'],
        paths: {
            auditFile: '/tmp/manager-audit.ndjson',
            baseConfigFile: '/tmp/magic-sso.base.toml',
            lastGoodRuntimeConfigFile: '/tmp/magic-sso.runtime.last-good.toml',
            lockFile: '/tmp/manager.lock',
            runtimeConfigFile: '/tmp/magic-sso.runtime.toml',
            stateFile: '/tmp/manager-state.json',
        },
        service: {
            auth: {
                bearerToken: 'replace-me-with-a-dedicated-long-random-manager-api-token',
            },
            host: '127.0.0.1',
            port: 4311,
        },
    };
}

function createGateSettings(): ManagerRuntimeSettings {
    return {
        ...createBearerSettings(),
        service: {
            auth: {
                mode: 'gate',
                requiredScope: '*',
                requiredSiteId: 'manager-admin',
            },
            host: '127.0.0.1',
            port: 4311,
        },
    };
}

describe('manager service auth', () => {
    it('extracts bearer tokens from Authorization headers', () => {
        expect(extractBearerToken('Bearer token-value')).toBe('token-value');
        expect(extractBearerToken('Basic token-value')).toBeUndefined();
        expect(extractBearerToken(undefined)).toBeUndefined();
    });

    it('authenticates requests with the configured bearer token', () => {
        expect(
            authenticateApiRequest(
                createBearerSettings(),
                'Bearer replace-me-with-a-dedicated-long-random-manager-api-token',
            ),
        ).toEqual({
            authType: 'internal-bearer-token',
        });
    });

    it('rejects missing bearer auth headers', () => {
        expect(() => authenticateApiRequest(createBearerSettings(), undefined)).toThrowError(
            'Missing or invalid Authorization header.',
        );
    });

    it('rejects incorrect bearer tokens', () => {
        expect(() =>
            authenticateApiRequest(createBearerSettings(), 'Bearer wrong-token'),
        ).toThrowError('Forbidden');
    });

    it('authenticates Gate-forwarded identity headers for the configured admin site', () => {
        expect(
            authenticateGateRequest(createGateSettings(), {
                'x-magic-sso-site-id': 'manager-admin',
                'x-magic-sso-user-email': 'operator@example.com',
                'x-magic-sso-user-scope': '*',
            }),
        ).toEqual({
            authType: 'gate-forwarded-user',
            email: 'operator@example.com',
            scope: '*',
            siteId: 'manager-admin',
        });
    });

    it('rejects Gate auth when the required site id is missing or wrong', () => {
        expect(() =>
            authenticateGateRequest(createGateSettings(), {
                'x-magic-sso-site-id': 'client',
                'x-magic-sso-user-email': 'operator@example.com',
                'x-magic-sso-user-scope': '*',
            }),
        ).toThrowError('Forbidden');
        expect(() => authenticateGateRequest(createGateSettings(), {})).toThrowError(
            'Missing or invalid Gate identity headers.',
        );
    });

    it('rejects Gate auth when the forwarded scope does not satisfy the admin requirement', () => {
        expect(() =>
            authenticateGateRequest(
                {
                    ...createGateSettings(),
                    service: {
                        auth: {
                            mode: 'gate',
                            requiredScope: 'manager:admin',
                            requiredSiteId: 'manager-admin',
                        },
                        host: '127.0.0.1',
                        port: 4311,
                    },
                },
                {
                    'x-magic-sso-site-id': 'manager-admin',
                    'x-magic-sso-user-email': 'operator@example.com',
                    'x-magic-sso-user-scope': 'reports',
                },
            ),
        ).toThrowError('Forbidden');
    });

    it('accepts Gate auth through the shared manager request authenticator', () => {
        expect(
            authenticateManagerRequest(createGateSettings(), {
                'x-magic-sso-site-id': 'manager-admin',
                'x-magic-sso-user-email': 'operator@example.com',
                'x-magic-sso-user-scope': '*',
            }),
        ).toEqual({
            authType: 'gate-forwarded-user',
            email: 'operator@example.com',
            scope: '*',
            siteId: 'manager-admin',
        });
    });
});
