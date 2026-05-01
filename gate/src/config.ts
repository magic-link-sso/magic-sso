// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export type GateMode = 'path-prefix' | 'subdomain';

export interface GateConfigInput {
    cookieMaxAge?: number;
    cookieName?: string;
    cookiePath?: string;
    directUse?: boolean;
    jwtSecret?: string;
    mode?: GateMode;
    namespace?: string;
    port?: number;
    publicOrigin?: string;
    publicPathPrefix?: string;
    rateLimitKeyPrefix?: string;
    rateLimitMax?: number;
    rateLimitRedisUrl?: string | undefined;
    rateLimitWindowMs?: number;
    requestTimeoutMs?: number;
    serverUrl?: string;
    previewSecret?: string;
    trustProxy?: boolean;
    upstreamBasePath?: string;
    upstreamUrl?: string;
    wsEnabled?: boolean;
}

export interface GateConfig {
    cookieMaxAge?: number;
    cookieName: string;
    cookiePath: string;
    directUse: boolean;
    jwtSecret: string;
    mode: GateMode;
    namespace: string;
    namespaceRoot: string;
    port: number;
    protectedRootPath: string;
    publicOrigin: string;
    publicPathPrefix: string;
    rateLimitKeyPrefix: string;
    rateLimitMax: number;
    rateLimitRedisUrl: string | undefined;
    rateLimitWindowMs: number;
    requestTimeoutMs: number;
    serverUrl: string;
    previewSecret: string;
    trustProxy: boolean;
    upstreamBasePath: string;
    upstreamUrl: string;
    wsEnabled: boolean;
}

export interface GateTargetWarning {
    fieldName: 'auth.serverUrl' | 'gate.upstreamUrl';
    hostname: string;
    reason: string;
    url: string;
}

const MIN_SECRET_LENGTH = 32;

function configuredSecretSchema(fieldName: string): z.ZodString {
    return z
        .string()
        .min(
            MIN_SECRET_LENGTH,
            `${fieldName} must be at least ${MIN_SECRET_LENGTH} characters long.`,
        );
}

const gateTomlSchema = z
    .object({
        auth: z
            .object({
                jwtSecret: configuredSecretSchema('auth.jwtSecret'),
                serverUrl: z.string().min(1, 'auth.serverUrl is required.'),
                previewSecret: configuredSecretSchema('auth.previewSecret'),
            })
            .strict(),
        cookie: z
            .object({
                maxAge: z.number().int().positive().optional(),
                name: z.string().min(1).optional(),
                path: z.string().optional(),
            })
            .strict()
            .optional(),
        gate: z
            .object({
                directUse: z.boolean().optional(),
                mode: z.enum(['path-prefix', 'subdomain']).optional(),
                namespace: z.string().optional(),
                port: z.number().int().positive().optional(),
                publicOrigin: z.string().min(1, 'gate.publicOrigin is required.'),
                publicPathPrefix: z.string().optional(),
                rateLimitKeyPrefix: z.string().min(1).optional(),
                rateLimitMax: z.number().int().positive().optional(),
                rateLimitRedisUrl: z.string().url().optional(),
                rateLimitWindowMs: z.number().int().positive().optional(),
                requestTimeoutMs: z.number().int().positive().optional(),
                trustProxy: z.boolean().optional(),
                upstreamBasePath: z.string().optional(),
                upstreamUrl: z.string().min(1, 'gate.upstreamUrl is required.'),
                wsEnabled: z.boolean().optional(),
            })
            .strict(),
    })
    .strict();

function formatTomlValidationIssue(issue: z.ZodIssue | undefined): string {
    if (typeof issue === 'undefined') {
        return 'Invalid config.';
    }

    const issuePath = issue.path.map(String).join('.');
    if (issue.code === 'invalid_type' && issue.input === undefined && issuePath.length > 0) {
        return `${issuePath} is required.`;
    }

    return issuePath.length > 0 ? `${issuePath}: ${issue.message}` : issue.message;
}

function trimTrailingSlash(pathname: string): string {
    return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function normaliseSlashPath(
    value: string | undefined,
    options: { allowEmpty: boolean; envName: string },
): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return options.allowEmpty ? '' : '/';
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) {
        throw new Error(`${options.envName} must start with "/".`);
    }

    if (trimmed === '/') {
        return options.allowEmpty ? '' : '/';
    }

    return trimTrailingSlash(trimmed);
}

function normaliseNamespace(value: string | undefined): string {
    const namespace = normaliseSlashPath(value, {
        allowEmpty: false,
        envName: 'gate.namespace',
    });

    if (namespace === '/') {
        throw new Error('gate.namespace cannot be "/".');
    }

    return namespace;
}

function normaliseAbsoluteOrigin(value: string | undefined, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} is required.`);
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new Error(`${fieldName} must be an absolute URL.`);
    }

    if (
        parsedUrl.protocol !== 'http:' &&
        parsedUrl.protocol !== 'https:' &&
        parsedUrl.protocol !== 'ws:' &&
        parsedUrl.protocol !== 'wss:'
    ) {
        throw new Error(`${fieldName} must use http(s) or ws(s).`);
    }

    if (parsedUrl.search.length > 0 || parsedUrl.hash.length > 0) {
        throw new Error(`${fieldName} must not include search params or fragments.`);
    }

    if (parsedUrl.pathname !== '/' && parsedUrl.pathname.length > 0) {
        throw new Error(`${fieldName} must not include a path component.`);
    }

    return parsedUrl.origin;
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseIpv4Address(hostname: string): [number, number, number, number] | null {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return null;
    }

    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (
        octets.length !== 4 ||
        octets.some(
            (octet, index) => !/^\d+$/u.test(parts[index] ?? '') || octet < 0 || octet > 255,
        )
    ) {
        return null;
    }

    const [first, second, third, fourth] = octets;
    if (
        typeof first !== 'number' ||
        typeof second !== 'number' ||
        typeof third !== 'number' ||
        typeof fourth !== 'number'
    ) {
        return null;
    }

    return [first, second, third, fourth];
}

function getPrivateTargetReason(hostname: string): string | undefined {
    const normalizedHostname = stripIpv6Brackets(hostname).toLowerCase();
    if (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost')) {
        return 'localhost target';
    }

    const ipv4Address = parseIpv4Address(normalizedHostname);
    if (ipv4Address !== null) {
        const [first, second] = ipv4Address;
        if (first === 0) {
            return 'unspecified IPv4 target';
        }
        if (first === 10 || first === 127) {
            return 'private or loopback IPv4 target';
        }
        if (first === 100 && second >= 64 && second <= 127) {
            return 'carrier-grade NAT IPv4 target';
        }
        if (first === 169 && second === 254) {
            return 'link-local or metadata-service IPv4 target';
        }
        if (first === 172 && second >= 16 && second <= 31) {
            return 'private IPv4 target';
        }
        if (first === 192 && second === 168) {
            return 'private IPv4 target';
        }
    }

    if (isIP(normalizedHostname) === 6) {
        if (normalizedHostname === '::' || normalizedHostname === '::1') {
            return 'unspecified or loopback IPv6 target';
        }
        if (
            normalizedHostname.startsWith('fc') ||
            normalizedHostname.startsWith('fd') ||
            normalizedHostname.startsWith('fe8') ||
            normalizedHostname.startsWith('fe9') ||
            normalizedHostname.startsWith('fea') ||
            normalizedHostname.startsWith('feb')
        ) {
            return 'private or link-local IPv6 target';
        }
    }

    return undefined;
}

function buildGateTargetWarning(
    fieldName: GateTargetWarning['fieldName'],
    url: string,
): GateTargetWarning | undefined {
    const parsedUrl = new URL(url);
    const reason = getPrivateTargetReason(parsedUrl.hostname);
    if (typeof reason === 'undefined') {
        return undefined;
    }

    return {
        fieldName,
        hostname: parsedUrl.hostname,
        reason,
        url: parsedUrl.origin,
    };
}

export function collectGateTargetWarnings(config: GateConfig): GateTargetWarning[] {
    return [
        buildGateTargetWarning('auth.serverUrl', config.serverUrl),
        buildGateTargetWarning('gate.upstreamUrl', config.upstreamUrl),
    ].filter((warning): warning is GateTargetWarning => typeof warning !== 'undefined');
}

function normaliseRedisUrl(value: string | undefined, fieldName: string): string | undefined {
    if (typeof value === 'undefined') {
        return undefined;
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new Error(`${fieldName} must be a valid redis:// or rediss:// URL.`);
    }

    if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
        throw new Error(`${fieldName} must use the redis:// or rediss:// protocol.`);
    }

    return parsedUrl.toString();
}

function resolvePositiveInteger(
    value: number | undefined,
    fallback: number,
    fieldName: string,
): number {
    if (typeof value === 'undefined') {
        return fallback;
    }

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${fieldName} must be a positive integer.`);
    }

    return value;
}

function resolveOptionalPositiveInteger(
    value: number | undefined,
    fieldName: string,
): number | undefined {
    if (typeof value === 'undefined') {
        return undefined;
    }

    return resolvePositiveInteger(value, 1, fieldName);
}

function readRequiredString(value: string | undefined, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} is required.`);
    }

    return value.trim();
}

const placeholderSecretsByField = new Map<string, Set<string>>([
    ['auth.jwtSecret', new Set(['replace-with-a-real-jwt-secret-at-least-32-chars'])],
    ['auth.previewSecret', new Set(['replace-with-a-real-preview-secret-at-least-32-chars'])],
]);

function parseConfiguredSecret(value: string, fieldName: string): string {
    const trimmedValue = value.trim();
    if (trimmedValue.length < MIN_SECRET_LENGTH) {
        throw new Error(`${fieldName} must be at least ${MIN_SECRET_LENGTH} characters long.`);
    }

    const placeholderValues = placeholderSecretsByField.get(fieldName);
    if (placeholderValues?.has(trimmedValue)) {
        throw new Error(`${fieldName} must be replaced with a real secret value.`);
    }

    return value;
}

function joinPath(left: string, right: string): string {
    if (left.length === 0) {
        return right;
    }

    if (right === '/') {
        return `${left}/`;
    }

    return `${left}${right}`;
}

function resolveCookiePath(input: {
    cookiePath: string | undefined;
    mode: GateMode;
    publicPathPrefix: string;
}): string {
    const defaultCookiePath = input.mode === 'path-prefix' ? input.publicPathPrefix : '/';
    const cookiePath =
        typeof input.cookiePath === 'string'
            ? normaliseSlashPath(input.cookiePath, {
                  allowEmpty: false,
                  envName: 'cookie.path',
              })
            : defaultCookiePath;

    if (input.mode === 'path-prefix' && !cookiePath.startsWith(input.publicPathPrefix)) {
        throw new Error('cookie.path must stay within gate.publicPathPrefix in path-prefix mode.');
    }

    return cookiePath;
}

function resolveMode(value: GateMode | undefined): GateMode {
    if (typeof value === 'undefined') {
        return 'subdomain';
    }

    if (value === 'subdomain' || value === 'path-prefix') {
        return value;
    }

    throw new Error('gate.mode must be "subdomain" or "path-prefix".');
}

export function buildGatePath(config: GateConfig, pathname: string): string {
    return joinPath(config.namespaceRoot, pathname);
}

export function buildPublicUrl(config: GateConfig, pathname: string): string {
    return new URL(pathname, `${config.publicOrigin}/`).toString();
}

export function stripPublicPathPrefix(pathname: string, config: GateConfig): string | null {
    if (config.mode !== 'path-prefix') {
        return pathname;
    }

    if (pathname === config.publicPathPrefix) {
        return '/';
    }

    if (pathname.startsWith(`${config.publicPathPrefix}/`)) {
        return pathname.slice(config.publicPathPrefix.length);
    }

    return null;
}

export function isNamespacePath(pathname: string, config: GateConfig): boolean {
    return pathname === config.namespaceRoot || pathname.startsWith(`${config.namespaceRoot}/`);
}

export function normaliseReturnUrl(
    returnUrl: string | undefined,
    config: GateConfig,
    fallback: string = buildPublicUrl(
        config,
        config.protectedRootPath === '/' ? '/' : `${config.protectedRootPath}/`,
    ),
): string {
    if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
        return fallback;
    }

    const candidate =
        returnUrl.startsWith('/') && !returnUrl.startsWith('//')
            ? new URL(returnUrl, config.publicOrigin).toString()
            : returnUrl;

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(candidate);
    } catch {
        return fallback;
    }

    if (parsedUrl.origin !== config.publicOrigin) {
        return fallback;
    }

    if (config.mode === 'path-prefix') {
        const strippedPath = stripPublicPathPrefix(parsedUrl.pathname, config);
        if (strippedPath === null) {
            return fallback;
        }
    }

    if (isNamespacePath(parsedUrl.pathname, config)) {
        return fallback;
    }

    return parsedUrl.toString();
}

function mapGateTomlToInput(config: z.infer<typeof gateTomlSchema>): GateConfigInput {
    const input: GateConfigInput = {
        jwtSecret: config.auth.jwtSecret,
        publicOrigin: config.gate.publicOrigin,
        previewSecret: config.auth.previewSecret,
        serverUrl: config.auth.serverUrl,
        upstreamUrl: config.gate.upstreamUrl,
    };

    if (typeof config.cookie?.maxAge === 'number') {
        input.cookieMaxAge = config.cookie.maxAge;
    }

    if (typeof config.cookie?.name === 'string') {
        input.cookieName = config.cookie.name;
    }

    if (typeof config.cookie?.path === 'string') {
        input.cookiePath = config.cookie.path;
    }

    if (typeof config.gate.directUse === 'boolean') {
        input.directUse = config.gate.directUse;
    }

    if (typeof config.gate.mode !== 'undefined') {
        input.mode = config.gate.mode;
    }

    if (typeof config.gate.namespace === 'string') {
        input.namespace = config.gate.namespace;
    }

    if (typeof config.gate.port === 'number') {
        input.port = config.gate.port;
    }

    if (typeof config.gate.publicPathPrefix === 'string') {
        input.publicPathPrefix = config.gate.publicPathPrefix;
    }

    if (typeof config.gate.rateLimitKeyPrefix === 'string') {
        input.rateLimitKeyPrefix = config.gate.rateLimitKeyPrefix;
    }

    if (typeof config.gate.rateLimitMax === 'number') {
        input.rateLimitMax = config.gate.rateLimitMax;
    }

    if (typeof config.gate.rateLimitRedisUrl === 'string') {
        input.rateLimitRedisUrl = config.gate.rateLimitRedisUrl;
    }

    if (typeof config.gate.rateLimitWindowMs === 'number') {
        input.rateLimitWindowMs = config.gate.rateLimitWindowMs;
    }

    if (typeof config.gate.requestTimeoutMs === 'number') {
        input.requestTimeoutMs = config.gate.requestTimeoutMs;
    }

    if (typeof config.gate.trustProxy === 'boolean') {
        input.trustProxy = config.gate.trustProxy;
    }

    if (typeof config.gate.upstreamBasePath === 'string') {
        input.upstreamBasePath = config.gate.upstreamBasePath;
    }

    if (typeof config.gate.wsEnabled === 'boolean') {
        input.wsEnabled = config.gate.wsEnabled;
    }

    return input;
}

function parseGateToml(fileContents: string, filePath: string): GateConfigInput {
    let parsedToml: unknown;
    try {
        parsedToml = parseToml(fileContents);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse MAGIC_GATE_CONFIG_FILE (${filePath}): ${message}`);
    }

    const parsedConfig = gateTomlSchema.safeParse(parsedToml);
    if (!parsedConfig.success) {
        throw new Error(
            `Failed to validate MAGIC_GATE_CONFIG_FILE (${filePath}): ${formatTomlValidationIssue(parsedConfig.error.issues[0])}`,
        );
    }

    return mapGateTomlToInput(parsedConfig.data);
}

export function resolveGateConfig(config: GateConfigInput = {}): GateConfig {
    const mode = resolveMode(config.mode);
    const publicPathPrefix = normaliseSlashPath(config.publicPathPrefix, {
        allowEmpty: true,
        envName: 'gate.publicPathPrefix',
    });

    if (mode === 'subdomain' && publicPathPrefix.length > 0) {
        throw new Error('gate.publicPathPrefix must be empty in subdomain mode.');
    }

    if (mode === 'path-prefix' && publicPathPrefix.length === 0) {
        throw new Error('gate.publicPathPrefix is required in path-prefix mode.');
    }

    const namespace = normaliseNamespace(config.namespace ?? '/_magicgate');
    const namespaceRoot = joinPath(publicPathPrefix, namespace);
    const protectedRootPath = publicPathPrefix.length > 0 ? publicPathPrefix : '/';
    const cookieMaxAge = resolveOptionalPositiveInteger(config.cookieMaxAge, 'cookie.maxAge');
    const port = resolvePositiveInteger(config.port, 4000, 'gate.port');
    const rateLimitMax = resolvePositiveInteger(config.rateLimitMax, 240, 'gate.rateLimitMax');
    const rateLimitWindowMs = resolvePositiveInteger(
        config.rateLimitWindowMs,
        60_000,
        'gate.rateLimitWindowMs',
    );
    const requestTimeoutMs = resolvePositiveInteger(
        config.requestTimeoutMs,
        10_000,
        'gate.requestTimeoutMs',
    );

    return {
        ...(typeof cookieMaxAge === 'number' ? { cookieMaxAge } : {}),
        cookieName: config.cookieName ?? 'magic-sso',
        cookiePath: resolveCookiePath({
            cookiePath: config.cookiePath,
            mode,
            publicPathPrefix,
        }),
        directUse: config.directUse ?? false,
        jwtSecret: parseConfiguredSecret(
            readRequiredString(config.jwtSecret, 'auth.jwtSecret'),
            'auth.jwtSecret',
        ),
        mode,
        namespace,
        namespaceRoot,
        port,
        protectedRootPath,
        publicOrigin: normaliseAbsoluteOrigin(config.publicOrigin, 'gate.publicOrigin'),
        publicPathPrefix,
        rateLimitKeyPrefix: config.rateLimitKeyPrefix ?? 'magic-sso-gate',
        rateLimitMax,
        rateLimitRedisUrl: normaliseRedisUrl(config.rateLimitRedisUrl, 'gate.rateLimitRedisUrl'),
        rateLimitWindowMs,
        requestTimeoutMs,
        serverUrl: normaliseAbsoluteOrigin(config.serverUrl, 'auth.serverUrl'),
        previewSecret: parseConfiguredSecret(
            readRequiredString(config.previewSecret, 'auth.previewSecret'),
            'auth.previewSecret',
        ),
        trustProxy: config.trustProxy ?? false,
        upstreamBasePath: normaliseSlashPath(config.upstreamBasePath, {
            allowEmpty: true,
            envName: 'gate.upstreamBasePath',
        }),
        upstreamUrl: normaliseAbsoluteOrigin(config.upstreamUrl, 'gate.upstreamUrl'),
        wsEnabled: config.wsEnabled ?? true,
    };
}

export function readConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
    const filePath = env['MAGIC_GATE_CONFIG_FILE'];
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('MAGIC_GATE_CONFIG_FILE must point to a TOML config file.');
    }

    return filePath;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
    const filePath = readConfigFilePath(env);

    let fileContents: string;
    try {
        fileContents = readFileSync(filePath, 'utf8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read MAGIC_GATE_CONFIG_FILE (${filePath}): ${message}`);
    }

    return resolveGateConfig(parseGateToml(fileContents, filePath));
}
