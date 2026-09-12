// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { validateConfiguredSecret } from '@magic-link-sso/config-core';
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

/** Classify a private/reserved IPv4 target, or `undefined` for a routable one. */
function getPrivateIpv4Reason(
    address: readonly [number, number, number, number],
): string | undefined {
    const [first, second] = address;
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

    return first === 192 && second === 168 ? 'private IPv4 target' : undefined;
}

const privateIpv6Prefixes = ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb'];

/** Classify a private/reserved IPv6 target, or `undefined` for a routable one. */
function getPrivateIpv6Reason(hostname: string): string | undefined {
    if (hostname === '::' || hostname === '::1') {
        return 'unspecified or loopback IPv6 target';
    }

    return privateIpv6Prefixes.some((prefix) => hostname.startsWith(prefix))
        ? 'private or link-local IPv6 target'
        : undefined;
}

/**
 * Explain why `hostname` points somewhere the Gate should not proxy to, so the
 * operator is warned about an unroutable or SSRF-prone upstream.
 */
function getPrivateTargetReason(hostname: string): string | undefined {
    const normalizedHostname = stripIpv6Brackets(hostname).toLowerCase();
    if (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost')) {
        return 'localhost target';
    }

    const ipv4Address = parseIpv4Address(normalizedHostname);
    if (ipv4Address !== null) {
        return getPrivateIpv4Reason(ipv4Address);
    }

    return isIP(normalizedHostname) === 6 ? getPrivateIpv6Reason(normalizedHostname) : undefined;
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
    return validateConfiguredSecret(value, fieldName, placeholderSecretsByField.get(fieldName));
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

/**
 * Drop the entries whose value is `undefined`, so an optional TOML key that was
 * never set stays absent from the config input instead of overriding a default.
 */
type DefinedProperties<TValue> = {
    [TKey in keyof TValue]?: Exclude<TValue[TKey], undefined>;
};

function definedEntries<TValue extends object>(value: TValue): DefinedProperties<TValue> {
    // Object.fromEntries widens to Record<string, unknown>; the surviving entries
    // are the same keys the caller passed in, with `undefined` filtered out.
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => typeof entry !== 'undefined'),
    ) as DefinedProperties<TValue>;
}

function mapGateTomlToInput(config: z.infer<typeof gateTomlSchema>): GateConfigInput {
    return {
        jwtSecret: config.auth.jwtSecret,
        publicOrigin: config.gate.publicOrigin,
        previewSecret: config.auth.previewSecret,
        serverUrl: config.auth.serverUrl,
        upstreamUrl: config.gate.upstreamUrl,
        ...definedEntries({
            cookieMaxAge: config.cookie?.maxAge,
            cookieName: config.cookie?.name,
            cookiePath: config.cookie?.path,
            directUse: config.gate.directUse,
            mode: config.gate.mode,
            namespace: config.gate.namespace,
            port: config.gate.port,
            publicPathPrefix: config.gate.publicPathPrefix,
            rateLimitKeyPrefix: config.gate.rateLimitKeyPrefix,
            rateLimitMax: config.gate.rateLimitMax,
            rateLimitRedisUrl: config.gate.rateLimitRedisUrl,
            rateLimitWindowMs: config.gate.rateLimitWindowMs,
            requestTimeoutMs: config.gate.requestTimeoutMs,
            trustProxy: config.gate.trustProxy,
            upstreamBasePath: config.gate.upstreamBasePath,
            wsEnabled: config.gate.wsEnabled,
        }),
    };
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
