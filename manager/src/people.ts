// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Wojciech Polak

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
    buildSiteAccessRules,
    parseMagicSsoTomlConfig,
    type MagicSsoTomlSite,
} from '@magic-link-sso/config-core';
import { z } from 'zod';
import { loadManagerAuditEvents } from './audit.js';
import { buildRuntimePlan } from './runtime.js';
import { updateSiteGrant } from './service.js';
import { normalizeManagerState, stringifyManagerState, type ManagerState } from './state.js';
import { assertManagerAuditConfig, type ManagerRuntimeSettings } from './settings.js';

const emailSchema = z.string().trim().toLowerCase().email();
const changeSchema = z
    .object({
        siteId: z.string().min(1),
        scopes: z.array(z.string().trim().min(1)),
    })
    .strict();
const previewSchema = z
    .object({
        email: emailSchema,
        changes: z.array(changeSchema).min(1),
        baseline: z.string(),
        expiresAt: z.number(),
    })
    .strict();

export interface PersonAccessChange {
    siteId: string;
    scopes: string[];
}

export class PersonPreviewConflictError extends Error {}

export interface PersonApplicationAccess {
    siteId: string;
    name: string;
    managed: boolean;
    scopeCatalog: string[];
    savedScopes: string[];
    publishedScopes: string[] | undefined;
    sources: string[];
    publishedSources: string[];
}

export interface PersonAccessView {
    email: string;
    applications: PersonApplicationAccess[];
    activation: string;
    activeConfirmed: boolean;
    jwtLifetimeSeconds: number;
}

export interface PersonAccessPreview {
    email: string;
    changes: PersonAccessChange[];
    token: string;
    nextState: ManagerState;
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function runtimeContents(settings: ManagerRuntimeSettings): string | undefined {
    return existsSync(settings.paths.runtimeConfigFile)
        ? readFileSync(settings.paths.runtimeConfigFile, 'utf8')
        : undefined;
}

function baseline(state: ManagerState, settings: ManagerRuntimeSettings): string {
    return hash(
        JSON.stringify([
            stringifyManagerState(state),
            readFileSync(settings.paths.baseConfigFile, 'utf8'),
            runtimeContents(settings),
            settings.managedSiteIds,
        ]),
    );
}

function signature(payload: string, settings: ManagerRuntimeSettings): string {
    assertManagerAuditConfig(settings);
    return createHmac('sha256', settings.audit.integrityKey)
        .update('manager-person-preview-v1\0')
        .update(payload)
        .digest('base64url');
}

function scopesFor(site: MagicSsoTomlSite, email: string): string[] {
    const scopes = [...(buildSiteAccessRules(site).get(email) ?? [])];
    return scopes.includes('*') ? ['*'] : scopes.sort();
}

function sourcesFor(
    site: MagicSsoTomlSite,
    email: string,
    managed: boolean,
    fileLabel = 'Operator base config',
): string[] {
    if (managed) {
        return scopesFor(site, email).length ? [`Manager state grant: ${site.id} / ${email}`] : [];
    }
    return [
        ...(site.allowedEmails.some((entry) => entry.trim().toLowerCase() === email)
            ? [`${fileLabel}: ${site.id}.allowedEmails`]
            : []),
        ...site.accessRules.flatMap((rule, index) =>
            rule.email.trim().toLowerCase() === email
                ? [`${fileLabel}: ${site.id}.accessRules[${index}] (${rule.scopes.join(', ')})`]
                : [],
        ),
    ];
}

export function getPersonAccess(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    email: string,
): PersonAccessView {
    const normalizedEmail = emailSchema.parse(email);
    const plan = buildRuntimePlan(state, settings);
    const contents = runtimeContents(settings);
    const published =
        contents === undefined
            ? undefined
            : parseMagicSsoTomlConfig(contents, settings.paths.runtimeConfigFile);
    const lastApply = loadManagerAuditEvents(settings).find(
        (event) => event.kind === 'apply-succeeded' || event.kind === 'apply-failed',
    );
    const activeConfirmed =
        contents !== undefined &&
        lastApply?.kind === 'apply-succeeded' &&
        lastApply?.reloaded === true &&
        lastApply.runtimeConfigHash === hash(contents);
    const savedSites = new Map(plan.runtimeConfig.sites.map((site) => [site.id, site]));
    const applicationSites = new Map([
        ...(published?.sites ?? []).map((site): [string, MagicSsoTomlSite] => [site.id, site]),
        ...savedSites,
    ]);
    return {
        email: normalizedEmail,
        activeConfirmed,
        jwtLifetimeSeconds: plan.validatedRuntimeConfig.jwtExpirationSeconds,
        activation: activeConfirmed
            ? `Last confirmed active at ${lastApply.timestamp}. This is the last manager reload acknowledgement; external server changes are not observed.`
            : 'Active configuration is unconfirmed. A runtime file alone does not prove that the server loaded it. Publish with a configured reload endpoint, or verify the server reload/restart yourself.',
        applications: [...applicationSites.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((site) => {
                const savedSite = savedSites.get(site.id);
                const managed =
                    savedSite !== undefined && settings.managedSiteIds.includes(site.id);
                const publishedSite = published?.sites.find((entry) => entry.id === site.id);
                return {
                    siteId: site.id,
                    name: site.launcher?.name ?? site.id,
                    managed,
                    scopeCatalog: state.managedSites[site.id]?.scopeCatalog ?? [],
                    savedScopes:
                        savedSite === undefined ? [] : scopesFor(savedSite, normalizedEmail),
                    publishedScopes:
                        publishedSite === undefined
                            ? undefined
                            : scopesFor(publishedSite, normalizedEmail),
                    sources:
                        savedSite === undefined
                            ? []
                            : sourcesFor(savedSite, normalizedEmail, managed),
                    publishedSources:
                        publishedSite === undefined
                            ? []
                            : sourcesFor(
                                  publishedSite,
                                  normalizedEmail,
                                  false,
                                  'Published runtime config',
                              ),
                };
            }),
    };
}

export function listPeople(state: ManagerState, settings: ManagerRuntimeSettings): string[] {
    const plan = buildRuntimePlan(state, settings);
    const contents = runtimeContents(settings);
    const publishedSites =
        contents === undefined
            ? []
            : parseMagicSsoTomlConfig(contents, settings.paths.runtimeConfigFile).sites;
    return [
        ...new Set(
            [...plan.runtimeConfig.sites, ...publishedSites].flatMap((site) => [
                ...buildSiteAccessRules(site).keys(),
            ]),
        ),
    ].sort();
}

export function changePersonAccess(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    email: string,
    changes: readonly PersonAccessChange[],
): ManagerState {
    const normalizedEmail = emailSchema.parse(email);
    const parsedChanges = z.array(changeSchema).min(1).parse(changes);
    if (new Set(parsedChanges.map((change) => change.siteId)).size !== parsedChanges.length) {
        throw new Error('Select each application only once.');
    }
    let nextState = normalizeManagerState(state);
    for (const change of parsedChanges) {
        const site = nextState.managedSites[change.siteId];
        if (!settings.managedSiteIds.includes(change.siteId) || site === undefined) {
            throw new Error(`Managed site ${change.siteId} is not available.`);
        }
        if (change.scopes.length === 0) {
            site.grants = site.grants.filter((grant) => grant.email !== normalizedEmail);
        } else {
            nextState = updateSiteGrant(
                nextState,
                settings,
                change.siteId,
                normalizedEmail,
                change.scopes,
            );
        }
    }
    buildRuntimePlan(nextState, settings);
    return nextState;
}

export function previewPersonAccess(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    email: string,
    changes: PersonAccessChange[],
    now = new Date(),
): PersonAccessPreview {
    const nextState = changePersonAccess(state, settings, email, changes);
    const data = previewSchema.parse({
        email,
        changes,
        baseline: baseline(state, settings),
        expiresAt: now.getTime() + 10 * 60_000,
    });
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return {
        email: data.email,
        changes: data.changes,
        token: `${payload}.${signature(payload, settings)}`,
        nextState,
    };
}

export function confirmPersonAccess(
    state: ManagerState,
    settings: ManagerRuntimeSettings,
    token: string,
    now = new Date(),
): PersonAccessPreview {
    const [payload, providedSignature, extra] = token.split('.');
    const invalid = (): Error =>
        new PersonPreviewConflictError(
            'Preview expired or changed. Review access again before saving.',
        );
    if (!payload || !providedSignature || extra !== undefined) {
        throw invalid();
    }
    const expected = Buffer.from(signature(payload, settings));
    const provided = Buffer.from(providedSignature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw invalid();
    }
    const data = previewSchema.parse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (data.expiresAt <= now.getTime() || data.baseline !== baseline(state, settings)) {
        throw invalid();
    }
    return {
        email: data.email,
        changes: data.changes,
        token,
        nextState: changePersonAccess(state, settings, data.email, data.changes),
    };
}
