/**
 * manager/src/ui.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { escapeHtml } from '@magic-link-sso/config-core/runtime';
import { type ManagerAuditEvent } from './apply.js';
import { type ConfigDriftStatus, type ManagedSiteDiff } from './runtime.js';
import {
    type ManagedSiteDetails,
    type ManagerReconcileStatus,
    type ManagedSiteSummary,
    type ManagerDiffResult,
} from './service.js';

export interface ManagerPageNotice {
    kind: 'error' | 'success' | 'warning';
    text: string;
}

export interface ManagerDashboardSiteItem extends ManagedSiteSummary {
    pendingChanges: boolean;
}

export interface ManagerErrorPageOptions {
    details?: string | undefined;
    message: string;
    statusCode: number;
}

export interface ManagerDashboardPageOptions {
    driftStatus?: ConfigDriftStatus | undefined;
    lastAppliedAt?: string | undefined;
    notice?: ManagerPageNotice | undefined;
    recentAuditEvents: readonly ManagerAuditEvent[];
    signOutPath?: string | undefined;
    sites: readonly ManagerDashboardSiteItem[];
}

export interface ManagerSiteScopeCatalogItem {
    inUseCount: number;
    name: string;
}

export interface ManagerSitePageOptions {
    canEdit: boolean;
    driftStatus?: ConfigDriftStatus | undefined;
    editorState?: ManagerSitePageEditorState | undefined;
    lastAppliedAt?: string | undefined;
    notice?: ManagerPageNotice | undefined;
    pendingSiteDiff?: ManagedSiteDiff | undefined;
    site: ManagedSiteDetails;
    signOutPath?: string | undefined;
    siteScopeCatalog: readonly ManagerSiteScopeCatalogItem[];
}

export interface ManagerSiteEditorDraft {
    email: string;
    scopes: readonly string[];
}

export interface ManagerSitePageEditorState {
    addPersonDraft?: ManagerSiteEditorDraft | undefined;
    addPersonOpen?: boolean | undefined;
    expandedGrantDraft?: ManagerSiteEditorDraft | undefined;
    expandedGrantEmail?: string | undefined;
}

export interface ManagerDiffPageOptions {
    canApply: boolean;
    diff: ManagerDiffResult;
    lastAppliedAt?: string | undefined;
    notice?: ManagerPageNotice | undefined;
    reloadConfigured: boolean;
    runtimeConfigFile: string;
    signOutPath?: string | undefined;
}

export interface ManagerAuditPageOptions {
    driftStatus?: ConfigDriftStatus | undefined;
    events: readonly ManagerAuditEvent[];
    notice?: ManagerPageNotice | undefined;
    signOutPath?: string | undefined;
}

export interface ManagerReconcilePageOptions {
    driftStatus?: ConfigDriftStatus | undefined;
    exportStateJson: string;
    importStateJson: string;
    lastAppliedAt?: string | undefined;
    notice?: ManagerPageNotice | undefined;
    reconcileStatus: ManagerReconcileStatus;
    signOutPath?: string | undefined;
}

export interface ManagerLoginPageOptions {
    notice?: ManagerPageNotice | undefined;
    returnTo: string;
}

interface ManagerShellOptions {
    currentPath: '/audit' | '/diff' | '/reconcile' | '/' | `/sites/${string}`;
    driftStatus?: ConfigDriftStatus | undefined;
    notice?: ManagerPageNotice | undefined;
    signOutPath?: string | undefined;
    subtitle: string;
    title: string;
}

function formatTimestampFallback(timestamp: Date): string {
    return `${timestamp.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function renderTimestamp(value: string | undefined): string {
    if (typeof value !== 'string' || value.length === 0) {
        return 'Not applied yet';
    }

    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
        return escapeHtml(value);
    }

    const isoTimestamp = timestamp.toISOString();
    return `<time class="local-time" datetime="${escapeHtml(isoTimestamp)}" data-local-time="true">${escapeHtml(formatTimestampFallback(timestamp))}</time>`;
}

function formatCount(value: number, noun: string): string {
    return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function formatHashPreview(value: string | undefined): string {
    if (typeof value !== 'string' || value.length === 0) {
        return 'missing';
    }

    return value.slice(0, 16);
}

function isFullAccessGrant(scopes: readonly string[]): boolean {
    return scopes[0] === '*';
}

function describeAccessSummary(scopes: readonly string[]): string {
    return isFullAccessGrant(scopes)
        ? 'Full site access'
        : formatCount(scopes.length, 'permission');
}

function buildNavLink(path: string, label: string, currentPath: string): string {
    const isActive = currentPath === path || (path === '/' && currentPath.startsWith('/sites/'));

    return `<a class="nav-link${isActive ? ' nav-link-active' : ''}" href="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
}

function renderNotice(notice: ManagerPageNotice | undefined): string {
    if (typeof notice === 'undefined') {
        return '';
    }

    return `<div class="notice notice-${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(notice.text)}</div>`;
}

function renderDriftBanner(driftStatus: ConfigDriftStatus | undefined): string {
    if (typeof driftStatus === 'undefined') {
        return '';
    }

    if (!driftStatus.baseConfigDrifted && !driftStatus.runtimeConfigDrifted) {
        return `<section class="banner banner-ok" aria-label="Drift status"><strong>In sync.</strong> The base and runtime files still match the last successful apply.</section>`;
    }

    const summary = driftStatus.baseConfigDrifted
        ? 'The operator-authored base config changed since the last apply, so UI write actions are frozen until reconciliation.'
        : 'The current runtime file no longer matches the last manager-generated runtime.';

    return `<section class="banner banner-warning stack" aria-label="Drift warning">
      <div>
        <p class="banner-title">Drift detected</p>
        <p class="banner-copy">${escapeHtml(summary)}</p>
      </div>
      <dl class="hash-list">
        ${
            driftStatus.baseConfigDrifted
                ? `<div>
            <dt>Base config</dt>
            <dd class="code">expected ${escapeHtml(formatHashPreview(driftStatus.expectedBaseConfigHash))} → current ${escapeHtml(formatHashPreview(driftStatus.currentBaseConfigHash))}</dd>
          </div>`
                : ''
        }
        ${
            driftStatus.runtimeConfigDrifted
                ? `<div>
            <dt>Runtime file</dt>
            <dd class="code">expected ${escapeHtml(formatHashPreview(driftStatus.expectedRuntimeConfigHash))} → current ${escapeHtml(formatHashPreview(driftStatus.currentRuntimeConfigHash))}</dd>
          </div>`
                : ''
        }
      </dl>
    </section>`;
}

function renderShell(options: ManagerShellOptions, body: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="same-origin" />
    <title>${escapeHtml(options.title)} | Magic Link SSO Manager</title>
    <style>
      * {
        box-sizing: border-box;
      }

      :root {
        color-scheme: light dark;
        --paper: #f4eedf;
        --paper-shadow: rgba(67, 56, 37, 0.14);
        --ink: #231d13;
        --muted: rgba(35, 29, 19, 0.72);
        --line: rgba(86, 67, 34, 0.16);
        --line-strong: rgba(86, 67, 34, 0.32);
        --panel: rgba(255, 251, 241, 0.92);
        --panel-alt: rgba(246, 238, 220, 0.92);
        --accent: #8b5a2b;
        --accent-deep: #5e3c1e;
        --success: #2f6b43;
        --success-bg: rgba(47, 107, 67, 0.12);
        --warning: #8a4b0f;
        --warning-bg: rgba(138, 75, 15, 0.12);
        --error: #9b2c2c;
        --error-bg: rgba(155, 44, 44, 0.12);
        --shadow: 0 24px 80px rgba(35, 29, 19, 0.12);
        --paper-glow: rgba(255, 255, 255, 0.42);
        --body-glint: rgba(255, 255, 255, 0.18);
        --body-accent-haze: rgba(139, 90, 43, 0.1);
        --field-bg: rgba(255, 255, 255, 0.54);
        --field-placeholder: rgba(35, 29, 19, 0.48);
        --button-ink: #fff8f0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --paper: #120f0b;
          --paper-shadow: rgba(0, 0, 0, 0.42);
          --ink: #f5ecdc;
          --muted: rgba(245, 236, 220, 0.7);
          --line: rgba(224, 195, 136, 0.12);
          --line-strong: rgba(224, 195, 136, 0.24);
          --panel: rgba(29, 23, 16, 0.92);
          --panel-alt: rgba(40, 31, 22, 0.9);
          --accent: #d7a164;
          --accent-deep: #f2c889;
          --success: #7dd3a1;
          --success-bg: rgba(125, 211, 161, 0.12);
          --warning: #f0b36c;
          --warning-bg: rgba(240, 179, 108, 0.12);
          --error: #fca5a5;
          --error-bg: rgba(252, 165, 165, 0.12);
          --shadow: 0 30px 100px rgba(0, 0, 0, 0.34);
          --paper-glow: rgba(255, 255, 255, 0.06);
          --body-glint: rgba(255, 255, 255, 0.04);
          --body-accent-haze: rgba(215, 161, 100, 0.14);
          --field-bg: rgba(255, 248, 240, 0.08);
          --field-placeholder: rgba(245, 236, 220, 0.5);
          --button-ink: #1b140d;
        }
      }

      html {
        background:
          radial-gradient(circle at top, var(--paper-glow), transparent 40%),
          linear-gradient(180deg, var(--paper) 0%, color-mix(in srgb, var(--paper) 85%, #cba96c 15%) 100%);
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          linear-gradient(140deg, var(--body-glint), transparent 42%),
          radial-gradient(circle at bottom right, var(--body-accent-haze), transparent 34%);
      }

      a {
        color: inherit;
      }

      .app-shell {
        max-width: 1240px;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }

      .masthead {
        margin-bottom: 1rem;
        padding: 1rem 1.1rem;
        border: 1px solid var(--line);
        border-radius: 1.5rem;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }

      .masthead-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.24em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.2rem, 4vw, 3.7rem);
        line-height: 0.98;
        letter-spacing: -0.05em;
      }

      .subtitle {
        margin: 0.75rem 0 0;
        max-width: 46rem;
        color: var(--muted);
        line-height: 1.65;
      }

      .nav-row {
        display: flex;
        gap: 0.65rem;
        flex-wrap: wrap;
        margin-top: 1rem;
        align-items: center;
        justify-content: space-between;
      }

      .nav-links {
        display: flex;
        gap: 0.65rem;
        flex-wrap: wrap;
        align-items: center;
      }

      .nav-signout {
        margin: 0;
      }

      .nav-link {
        padding: 0.65rem 0.9rem;
        border: 1px solid var(--line);
        border-radius: 999px;
        text-decoration: none;
        background: color-mix(in srgb, var(--panel) 78%, transparent 22%);
      }

      .nav-link:hover,
      .nav-link:focus-visible {
        border-color: var(--line-strong);
      }

      .nav-link-active {
        border-color: var(--accent);
        color: var(--accent-deep);
        background: color-mix(in srgb, var(--panel-alt) 82%, transparent 18%);
      }

      .stack {
        display: grid;
        gap: 1rem;
        align-content: start;
      }

      .site-page-main {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1rem;
      }

      .hero-grid,
      .detail-grid {
        display: grid;
        gap: 1rem;
        align-items: start;
      }

      @media (min-width: 960px) {
        .hero-grid {
          grid-template-columns: minmax(0, 1.5fr) minmax(21rem, 0.9fr);
        }

        .detail-grid {
          grid-template-columns: minmax(0, 1.4fr) minmax(19rem, 0.8fr);
        }
      }

      .panel {
        padding: 1.15rem;
        border: 1px solid var(--line);
        border-radius: 1.4rem;
        background: var(--panel);
        box-shadow: var(--shadow);
        width: 100%;
      }

      .panel-alt {
        background: var(--panel-alt);
      }

      .panel h2,
      .panel h3 {
        margin: 0;
        letter-spacing: -0.03em;
      }

      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }

      .muted {
        color: var(--muted);
      }

      .metric-grid {
        display: grid;
        gap: 0.8rem;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      }

      .table-value-list {
        display: grid;
        gap: 0.35rem;
      }

      .table-value-item {
        display: block;
        overflow-wrap: anywhere;
      }

      .metric {
        padding: 0.95rem 1rem;
        border: 1px solid var(--line);
        border-radius: 1.1rem;
        background: color-mix(in srgb, var(--panel) 72%, transparent 28%);
      }

      .metric-label {
        margin: 0;
        color: var(--muted);
        font-size: 0.86rem;
      }

      .metric-value {
        margin: 0.3rem 0 0;
        font-size: 1.6rem;
        letter-spacing: -0.04em;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 0.8rem 0.65rem;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      tbody tr:last-child td {
        border-bottom: none;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        margin: 0.1rem 0.4rem 0.2rem 0;
        padding: 0.28rem 0.65rem;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: color-mix(in srgb, var(--panel-alt) 88%, transparent 12%);
        font-size: 0.9rem;
      }

      .pill-accent {
        border-color: color-mix(in srgb, var(--accent) 50%, var(--line) 50%);
        color: var(--accent-deep);
      }

      .code {
        font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
        font-size: 0.9rem;
      }

      .notice,
      .banner {
        padding: 0.95rem 1rem;
        border-radius: 1.1rem;
        border: 1px solid var(--line);
      }

      .notice-success,
      .banner-ok {
        border-color: color-mix(in srgb, var(--success) 40%, var(--line) 60%);
        background: var(--success-bg);
      }

      .notice-warning,
      .banner-warning {
        border-color: color-mix(in srgb, var(--warning) 48%, var(--line) 52%);
        background: var(--warning-bg);
      }

      .notice-error {
        border-color: color-mix(in srgb, var(--error) 46%, var(--line) 54%);
        background: var(--error-bg);
      }

      .banner-title {
        margin: 0 0 0.35rem;
        font-size: 1.05rem;
        font-weight: 700;
      }

      .banner-copy {
        margin: 0;
      }

      .site-link {
        font-size: 1.08rem;
        font-weight: 700;
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.18em;
      }

      .empty-state {
        padding: 1rem;
        border: 1px dashed var(--line-strong);
        border-radius: 1rem;
        color: var(--muted);
      }

      .definition-list {
        display: grid;
        gap: 0.75rem;
      }

      .definition-list div {
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--line);
      }

      .definition-list div:last-child {
        padding-bottom: 0;
        border-bottom: none;
      }

      .definition-list dt {
        margin-bottom: 0.25rem;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .definition-list dd {
        margin: 0;
        overflow-wrap: anywhere;
      }

      .event-list {
        display: grid;
        gap: 0.9rem;
      }

      .event-item {
        padding: 0.95rem 1rem;
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: color-mix(in srgb, var(--panel-alt) 82%, transparent 18%);
      }

      .event-item h3 {
        margin: 0 0 0.35rem;
        font-size: 1.05rem;
      }

      .event-meta {
        margin: 0;
        color: var(--muted);
        font-size: 0.9rem;
      }

      .hash-list {
        display: grid;
        gap: 0.65rem;
      }

      .hash-list div {
        display: grid;
        gap: 0.18rem;
      }

      .hash-list dt {
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .hash-list dd {
        margin: 0;
      }

      .event-facts {
        gap: 0.75rem 1rem;
      }

      .event-facts div {
        gap: 0.18rem;
      }

      .event-facts dd {
        overflow-wrap: anywhere;
      }

      @media (min-width: 900px) {
        .event-facts {
          grid-template-columns: minmax(0, 1.45fr) repeat(3, minmax(0, 1fr));
        }
      }

      .status-row {
        display: inline-flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 0.25rem 0.6rem;
        border: 1px solid var(--line);
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.03em;
      }

      .status-badge-success {
        border-color: color-mix(in srgb, var(--success) 40%, var(--line) 60%);
        background: var(--success-bg);
      }

      .status-badge-warning {
        border-color: color-mix(in srgb, var(--warning) 48%, var(--line) 52%);
        background: var(--warning-bg);
      }

      .status-badge-error {
        border-color: color-mix(in srgb, var(--error) 46%, var(--line) 54%);
        background: var(--error-bg);
      }

      .login-shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1.5rem;
      }

      .login-card {
        width: min(100%, 32rem);
        padding: 2rem;
        border: 1px solid var(--line);
        border-radius: 1.75rem;
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .login-copy {
        color: var(--muted);
        line-height: 1.65;
      }

      label {
        display: block;
        margin-bottom: 0.4rem;
        font-weight: 700;
      }

      input[type="password"],
      textarea {
        width: 100%;
        margin-bottom: 1rem;
        padding: 0.9rem 0.95rem;
        border: 1px solid var(--line-strong);
        border-radius: 1rem;
        color: var(--ink);
        background: var(--field-bg);
        font: inherit;
      }

      textarea {
        min-height: 12rem;
        resize: vertical;
      }

      input[type="email"],
      input[type="text"],
      select {
        width: 100%;
        margin-bottom: 1rem;
        padding: 0.9rem 0.95rem;
        border: 1px solid var(--line-strong);
        border-radius: 1rem;
        color: var(--ink);
        background: var(--field-bg);
        font: inherit;
      }

      input::placeholder,
      textarea::placeholder {
        color: var(--field-placeholder);
      }

      fieldset {
        margin: 0;
        padding: 0;
        border: 0;
      }

      .field-help {
        margin: -0.6rem 0 1rem;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .editor-grid {
        display: grid;
        gap: 1rem;
      }

      .grant-editor-list {
        display: grid;
        gap: 1rem;
      }

      .disclosure {
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: color-mix(in srgb, var(--panel) 74%, transparent 26%);
      }

      .disclosure[open] {
        background: color-mix(in srgb, var(--panel) 82%, transparent 18%);
      }

      .disclosure[open] .grant-list-action {
        display: none;
      }

      .disclosure-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.8rem;
        padding: 1rem;
        cursor: pointer;
        list-style: none;
      }

      .disclosure-summary::-webkit-details-marker {
        display: none;
      }

      .disclosure-copy {
        display: grid;
        gap: 0.2rem;
      }

      .disclosure-title {
        font-size: 1.02rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }

      .disclosure-body {
        padding: 0 1rem 1rem;
      }

      .grant-editor-card {
        overflow: hidden;
      }

      .grant-editor-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.8rem;
        flex-wrap: wrap;
      }

      .grant-list {
        display: grid;
        gap: 0.75rem;
      }

      .grant-list-item {
        overflow: hidden;
      }

      .grant-list-summary {
        align-items: center;
      }

      .grant-list-primary {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .grant-list-email {
        font-weight: 700;
      }

      .grant-list-action {
        color: var(--accent-deep);
        font-weight: 700;
      }

      .grant-list-body {
        display: grid;
        gap: 0.9rem;
      }

      .grant-list-body form {
        margin: 0;
      }

      .scope-grid {
        display: grid;
        gap: 0.65rem;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        margin-bottom: 1rem;
      }

      .scope-option {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: color-mix(in srgb, var(--panel-alt) 88%, transparent 12%);
      }

      .scope-option input {
        width: auto;
        margin: 0;
      }

      .scope-option span {
        font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
        font-size: 0.88rem;
      }

      .scope-catalog-list {
        display: grid;
        gap: 0.75rem;
      }

      .scope-catalog-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.8rem 0.9rem;
        border: 1px solid var(--line);
        border-radius: 1rem;
      }

      .scope-catalog-meta {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        flex-wrap: wrap;
      }

      .button-muted {
        border-color: var(--line-strong);
        color: var(--ink);
        background: transparent;
      }

      button:disabled,
      .button-muted:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .button-row {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      button,
      .button-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.85rem;
        padding: 0.85rem 1rem;
        border: 1px solid var(--accent);
        border-radius: 999px;
        color: var(--button-ink);
        background: linear-gradient(135deg, var(--accent), var(--accent-deep));
        text-decoration: none;
        font: inherit;
        white-space: nowrap;
        cursor: pointer;
      }

      .button-link-secondary {
        border-color: var(--line-strong);
        color: var(--ink);
        background: transparent;
      }

      .inline-link {
        color: var(--accent-deep);
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.16em;
      }

      .actions-inline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.8rem;
        flex-wrap: wrap;
      }

      .diff-list {
        display: grid;
        gap: 0.9rem;
      }

      .diff-item {
        padding: 1rem;
        border: 1px solid var(--line);
        border-radius: 1rem;
      }

      .diff-item h3 {
        margin-bottom: 0.6rem;
      }

      .mono-list {
        margin: 0;
        padding-left: 1.15rem;
      }

      .mono-list li {
        margin: 0.25rem 0;
        font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
        font-size: 0.9rem;
      }

      .page-links {
        display: inline-flex;
        gap: 0.7rem;
        flex-wrap: wrap;
        justify-self: start;
        width: fit-content;
      }
    </style>
  </head>
  <body>
    <main class="app-shell">
      <header class="masthead">
        <div class="masthead-top">
          <div>
            <p class="eyebrow">Magic Link SSO Manager</p>
            <h1>${escapeHtml(options.title)}</h1>
            <p class="subtitle">${escapeHtml(options.subtitle)}</p>
          </div>
        </div>
        <nav class="nav-row" aria-label="Manager navigation">
          <div class="nav-links">
            ${buildNavLink('/', 'Sites', options.currentPath)}
            ${buildNavLink('/diff', 'Diff', options.currentPath)}
            ${buildNavLink('/reconcile', 'Sync', options.currentPath)}
            ${buildNavLink('/audit', 'Audit', options.currentPath)}
          </div>
          ${
              typeof options.signOutPath === 'string'
                  ? `<form class="nav-signout" method="post" action="${escapeHtml(options.signOutPath)}">
              <button class="button-link button-link-secondary" type="submit">Sign out</button>
            </form>`
                  : ''
          }
        </nav>
      </header>
      <div class="stack">
        ${renderNotice(options.notice)}
        ${renderDriftBanner(options.driftStatus)}
        ${body}
      </div>
    </main>
    <script>
      (() => {
        const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        const titleFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

        for (const element of document.querySelectorAll('[data-local-time="true"]')) {
          if (!(element instanceof HTMLTimeElement) || element.dateTime.length === 0) {
            continue;
          }

          const timestamp = new Date(element.dateTime);
          if (Number.isNaN(timestamp.getTime())) {
            continue;
          }

          element.textContent = formatter.format(timestamp);
          element.title = titleFormatter.format(timestamp);
        }
      })();
    </script>
  </body>
</html>`;
}

function renderSiteDiff(siteDiff: ManagedSiteDiff, title: string): string {
    return `<div class="diff-item">
      <h3>${escapeHtml(title)}</h3>
      ${
          siteDiff.addedFullAccessEmails.length > 0
              ? `<p><strong>Added full site access</strong></p><ul class="mono-list">${siteDiff.addedFullAccessEmails
                    .map((email) => `<li>${escapeHtml(email)}</li>`)
                    .join('')}</ul>`
              : ''
      }
      ${
          siteDiff.removedFullAccessEmails.length > 0
              ? `<p><strong>Removed full site access</strong></p><ul class="mono-list">${siteDiff.removedFullAccessEmails
                    .map((email) => `<li>${escapeHtml(email)}</li>`)
                    .join('')}</ul>`
              : ''
      }
      ${
          siteDiff.addedScopedGrants.length > 0
              ? `<p><strong>Added limited access</strong></p><ul class="mono-list">${siteDiff.addedScopedGrants
                    .map(
                        (grant) =>
                            `<li>${escapeHtml(grant.email)} [${escapeHtml(grant.scopes.join(', '))}]</li>`,
                    )
                    .join('')}</ul>`
              : ''
      }
      ${
          siteDiff.removedScopedGrants.length > 0
              ? `<p><strong>Removed limited access</strong></p><ul class="mono-list">${siteDiff.removedScopedGrants
                    .map(
                        (grant) =>
                            `<li>${escapeHtml(grant.email)} [${escapeHtml(grant.scopes.join(', '))}]</li>`,
                    )
                    .join('')}</ul>`
              : ''
      }
    </div>`;
}

function renderPendingChanges(siteDiff: ManagedSiteDiff | undefined): string {
    if (typeof siteDiff === 'undefined') {
        return `<div class="empty-state">No pending access changes for this site.</div>`;
    }

    return renderSiteDiff(siteDiff, 'Pending changes');
}

function renderManagedSiteDiffList(
    changedSites: readonly ManagedSiteDiff[],
    emptyMessage: string,
): string {
    if (changedSites.length === 0) {
        return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    }

    return `<div class="diff-list">${changedSites
        .map((siteDiff) => renderSiteDiff(siteDiff, siteDiff.siteId))
        .join('')}</div>`;
}

function renderSitePills(values: readonly string[], accent = false): string {
    if (values.length === 0) {
        return '<span class="muted">None</span>';
    }

    return values
        .map(
            (value) =>
                `<span class="pill${accent ? ' pill-accent' : ''}">${escapeHtml(value)}</span>`,
        )
        .join('');
}

function renderTableValueList(values: readonly string[]): string {
    if (values.length === 0) {
        return '<span class="muted">None</span>';
    }

    return `<div class="table-value-list">${values
        .map((value) => `<span class="table-value-item code">${escapeHtml(value)}</span>`)
        .join('')}</div>`;
}

function renderScopeSelection(
    scopeCatalog: readonly string[],
    selectedScopes: readonly string[],
    disabled: boolean,
): string {
    if (scopeCatalog.length === 0) {
        return `<div class="empty-state">Add permissions first if you want to give limited access.</div>`;
    }

    return `<div class="scope-grid">${scopeCatalog
        .map(
            (scope, index) => `<label class="scope-option">
          <input
            type="checkbox"
            name="selectedScope${index}"
            value="${escapeHtml(scope)}"
            ${selectedScopes.includes(scope) ? 'checked' : ''}
            ${disabled ? 'disabled' : ''}
          />
          <span>${escapeHtml(scope)}</span>
        </label>`,
        )
        .join('')}</div>`;
}

function renderGrantForm(
    siteId: string,
    scopeCatalog: readonly string[],
    grant: { email: string; scopes: readonly string[] },
    canEdit: boolean,
    kind: 'existing' | 'new',
): string {
    const isFullAccess = isFullAccessGrant(grant.scopes);
    const selectedScopes = isFullAccess ? [] : [...grant.scopes];
    const formAction = `/sites/${encodeURIComponent(siteId)}/access/grants`;
    const revokeAction = `/sites/${encodeURIComponent(siteId)}/access/grants/${encodeURIComponent(grant.email)}/revoke`;

    return `<div class="grant-list-body">
      <div class="grant-editor-head">
        <div>
          <h3>${kind === 'new' ? 'Add person' : 'Edit access'}</h3>
          <p class="muted">${kind === 'new' ? 'Choose full site access or specific permissions.' : 'Update access or remove this person.'}</p>
        </div>
      </div>
      <form method="post" action="${formAction}">
        ${
            kind === 'existing'
                ? `<input type="hidden" name="grantEmail" value="${escapeHtml(grant.email)}" />`
                : `<label for="grant-email-new">Email</label>
          <input
            id="grant-email-new"
            type="email"
            name="grantEmail"
            placeholder="operator@example.com"
            autocomplete="email"
            required
            ${canEdit ? '' : 'disabled'}
          />`
        }
        <label for="${kind}-grant-mode">Access level</label>
        <select id="${kind}-grant-mode" name="grantMode" ${canEdit ? '' : 'disabled'}>
          <option value="scoped" ${isFullAccess ? '' : 'selected'}>Limited access</option>
          <option value="full-access" ${isFullAccess ? 'selected' : ''}>Full site access</option>
        </select>
        <fieldset>
          <label>Permissions</label>
          <p class="field-help">Choose one or more permissions when using limited access.</p>
          ${renderScopeSelection(scopeCatalog, selectedScopes, !canEdit)}
        </fieldset>
        <div class="button-row">
          <button type="submit" ${canEdit ? '' : 'disabled'}>${kind === 'new' ? 'Save access' : 'Save changes'}</button>
          ${
              kind === 'existing'
                  ? `<button class="button-muted" type="submit" formaction="${revokeAction}" formnovalidate ${canEdit ? '' : 'disabled'}>Remove access</button>`
                  : ''
          }
        </div>
      </form>
    </div>`;
}

function renderAddPersonComposer(
    siteId: string,
    scopeCatalog: readonly string[],
    draft: ManagerSiteEditorDraft,
    canEdit: boolean,
    isOpen: boolean,
): string {
    return `<details class="disclosure grant-editor-card" data-editor-kind="new" ${isOpen ? 'open' : ''}>
      <summary class="disclosure-summary">
        <span class="disclosure-title">Add person</span>
        <span class="grant-list-action">Add</span>
      </summary>
      <div class="disclosure-body">
        ${renderGrantForm(siteId, scopeCatalog, draft, canEdit, 'new')}
      </div>
    </details>`;
}

function renderGrantListItem(
    siteId: string,
    scopeCatalog: readonly string[],
    grant: { email: string; scopes: readonly string[] },
    canEdit: boolean,
    draft: ManagerSiteEditorDraft | undefined,
    isOpen: boolean,
): string {
    const editorGrant = typeof draft === 'undefined' ? grant : draft;

    return `<details class="disclosure grant-list-item" name="site-access-list" data-grant-email="${escapeHtml(grant.email)}" ${isOpen ? 'open' : ''}>
      <summary class="disclosure-summary grant-list-summary">
        <div class="grant-list-primary">
          <span class="grant-list-email">${escapeHtml(grant.email)}</span>
          <span class="pill${isFullAccessGrant(grant.scopes) ? ' pill-accent' : ''}">${escapeHtml(describeAccessSummary(grant.scopes))}</span>
        </div>
        <span class="grant-list-action">Edit</span>
      </summary>
      <div class="disclosure-body">
        ${renderGrantForm(siteId, scopeCatalog, editorGrant, canEdit, 'existing')}
      </div>
    </details>`;
}

function renderAuditEventBadges(event: ManagerAuditEvent): string {
    const eventKindBadgeClass =
        event.kind === 'apply-failed' ? 'status-badge-error' : 'status-badge-success';
    const badges: string[] = [
        `<span class="status-badge ${eventKindBadgeClass}">${escapeHtml(event.kind)}</span>`,
    ];

    if (event.reloaded) {
        badges.push('<span class="status-badge status-badge-success">Reloaded</span>');
    }

    if (event.rolledBack) {
        badges.push('<span class="status-badge status-badge-warning">Rolled back</span>');
    }

    if (
        event.driftStatus?.baseConfigDrifted === true ||
        event.driftStatus?.runtimeConfigDrifted === true
    ) {
        badges.push('<span class="status-badge status-badge-warning">Drift snapshot</span>');
    }

    return badges.join('');
}

function renderAuditActorMeta(event: ManagerAuditEvent): string {
    const actorSummary = `${event.actor.user}@${event.actor.host}`;
    return typeof event.actor.siteId === 'string'
        ? `${actorSummary} · via ${event.actor.siteId}`
        : actorSummary;
}

export function renderManagerDashboardPage(options: ManagerDashboardPageOptions): string {
    const changedSiteCount = options.sites.filter((site) => site.pendingChanges).length;
    const recentEvents = options.recentAuditEvents.slice(0, 4);

    return renderShell(
        {
            currentPath: '/',
            driftStatus: options.driftStatus,
            notice: options.notice,
            signOutPath: options.signOutPath,
            subtitle:
                'Review managed sites, inspect pending access changes, and keep the generated runtime under control without touching the base config by hand.',
            title: 'Operations Dashboard',
        },
        `<section class="hero-grid">
          <section class="panel stack">
            <div class="panel-head">
              <div>
                <h2>Managed sites</h2>
                <p class="muted">Only sites listed in manager settings are editable here.</p>
              </div>
              <div class="page-links">
                <a class="button-link button-link-secondary" href="/diff">Review changes</a>
                <a class="button-link button-link-secondary" href="/audit">Open audit log</a>
              </div>
            </div>
            <div class="metric-grid">
              <div class="metric">
                <p class="metric-label">Managed sites</p>
                <p class="metric-value">${options.sites.length}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Pending site changes</p>
                <p class="metric-value">${changedSiteCount}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Last applied</p>
                <p class="metric-value">${renderTimestamp(options.lastAppliedAt)}</p>
              </div>
            </div>
            ${
                options.sites.length === 0
                    ? `<div class="empty-state">No managed sites are configured yet.</div>`
                    : `<table>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Origins</th>
                  <th>Redirects</th>
                  <th>People</th>
                  <th>Permissions</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${options.sites
                    .map(
                        (site) => `<tr>
                    <td><a class="site-link" href="/sites/${encodeURIComponent(site.id)}">${escapeHtml(site.id)}</a></td>
                    <td>${renderTableValueList(site.origins)}</td>
                    <td>${renderTableValueList(site.allowedRedirectUris)}</td>
                    <td>${site.grantCount}</td>
                    <td>${site.scopeCount}</td>
                    <td>${site.pendingChanges ? '<span class="pill pill-accent">Pending edits</span>' : '<span class="muted">Clean</span>'}</td>
                  </tr>`,
                    )
                    .join('')}
              </tbody>
            </table>`
            }
          </section>
          <aside class="panel panel-alt stack">
            <div class="panel-head">
              <div>
                <h2>Recent audit</h2>
                <p class="muted">Latest manager apply activity and operator actions.</p>
              </div>
            </div>
            ${
                recentEvents.length === 0
                    ? `<div class="empty-state">No audit events have been recorded yet.</div>`
                    : `<div class="event-list">${recentEvents
                          .map(
                              (event) => `<article class="event-item">
                    <h3>${escapeHtml(event.kind)}</h3>
                    <p class="event-meta">${renderTimestamp(event.timestamp)} · ${escapeHtml(renderAuditActorMeta(event))}</p>
                    <p>${escapeHtml(event.message)}</p>
                  </article>`,
                          )
                          .join('')}</div>`
            }
          </aside>
        </section>`,
    );
}

export function renderManagerSitePage(options: ManagerSitePageOptions): string {
    const sortedGrants = [...options.site.grants].sort((left, right) =>
        left.email.localeCompare(right.email),
    );
    const addPersonDraft = options.editorState?.addPersonDraft ?? { email: '', scopes: [] };
    const expandedGrantEmail = options.editorState?.expandedGrantEmail;
    const expandedGrantDraft = options.editorState?.expandedGrantDraft;

    return renderShell(
        {
            currentPath: `/sites/${options.site.id}`,
            driftStatus: options.driftStatus,
            notice: options.notice,
            signOutPath: options.signOutPath,
            subtitle: 'Manage access for this site.',
            title: options.site.id,
        },
        `<section class="detail-grid">
          <section class="panel site-page-main">
            <div>
              <div>
                <h2>People with access</h2>
                <p class="muted">Manage who can enter this site.</p>
                <p><a class="inline-link" href="/">Back to site list</a></p>
              </div>
            </div>
            <section class="panel panel-alt">
              <div class="panel-head">
                <div>
                  <h3>Access list</h3>
                  <p class="muted">Add someone new or edit an existing person.</p>
                  ${
                      options.canEdit
                          ? ''
                          : `<p class="muted">Base drift is active, so access edits are temporarily frozen until the operator syncs the base config.</p>`
                  }
                </div>
              </div>
              <div class="grant-editor-list">
                ${renderAddPersonComposer(
                    options.site.id,
                    options.site.scopeCatalog,
                    addPersonDraft,
                    options.canEdit,
                    options.editorState?.addPersonOpen === true,
                )}
                ${
                    sortedGrants.length === 0
                        ? `<div class="empty-state">No one has manager-controlled access yet for this site.</div>`
                        : `<div class="grant-list">${sortedGrants
                              .map((grant) =>
                                  renderGrantListItem(
                                      options.site.id,
                                      options.site.scopeCatalog,
                                      grant,
                                      options.canEdit,
                                      expandedGrantEmail === grant.email
                                          ? expandedGrantDraft
                                          : undefined,
                                      expandedGrantEmail === grant.email,
                                  ),
                              )
                              .join('')}</div>`
                }
              </div>
            </section>
          </section>
          <aside class="stack">
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h2>Permissions</h2>
                  <p class="muted">These named permissions are the building blocks for limited access.</p>
                  ${
                      options.canEdit
                          ? ''
                          : `<p class="muted">Permission changes are disabled until the base config drift is resolved.</p>`
                  }
                </div>
              </div>
              <form method="post" action="/sites/${encodeURIComponent(options.site.id)}/scopes">
                <label for="new-scope">Add permission</label>
                <input
                  id="new-scope"
                  type="text"
                  name="scopeName"
                  placeholder="reports"
                  ${options.canEdit ? '' : 'disabled'}
                />
                <div class="button-row">
                  <button type="submit" ${options.canEdit ? '' : 'disabled'}>Add permission</button>
                </div>
              </form>
              <dl class="definition-list">
                <div>
                  <dt>Permissions</dt>
                  <dd>
                    ${
                        options.siteScopeCatalog.length === 0
                            ? `<div class="empty-state">No permissions exist yet for this site.</div>`
                            : `<div class="scope-catalog-list">${options.siteScopeCatalog
                                  .map(
                                      (scope) => `<article class="scope-catalog-item">
                            <div class="scope-catalog-meta">
                              <span class="pill pill-accent code">${escapeHtml(scope.name)}</span>
                              <span class="muted">Used by ${scope.inUseCount} ${scope.inUseCount === 1 ? 'person' : 'people'}</span>
                            </div>
                            <form method="post" action="/sites/${encodeURIComponent(options.site.id)}/scopes/${encodeURIComponent(scope.name)}/remove">
                              <button
                                class="button-muted"
                                type="submit"
                                ${options.canEdit && scope.inUseCount === 0 ? '' : 'disabled'}
                              >
                                Remove
                              </button>
                            </form>
                          </article>`,
                                  )
                                  .join('')}</div>`
                    }
                  </dd>
                </div>
              </dl>
            </section>
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h2>Technical details</h2>
                  <p class="muted">These values still come from the base config and stay read-only here.</p>
                </div>
              </div>
              <dl class="definition-list">
                <div>
                  <dt>Origins</dt>
                  <dd>${renderSitePills(options.site.origins)}</dd>
                </div>
                <div>
                  <dt>Allowed redirect URIs</dt>
                  <dd>${renderSitePills(options.site.allowedRedirectUris)}</dd>
                </div>
                <div>
                  <dt>Last applied</dt>
                  <dd>${renderTimestamp(options.lastAppliedAt)}</dd>
                </div>
              </dl>
            </section>
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h2>Pending changes</h2>
                  <p class="muted">This compares the current runtime target against the next manager render.</p>
                </div>
              </div>
              ${renderPendingChanges(options.pendingSiteDiff)}
            </section>
          </aside>
        </section>`,
    );
}

export function renderManagerDiffPage(options: ManagerDiffPageOptions): string {
    const changedSiteCount = options.diff.summary.changedSites.length;
    const applyDisabled = !options.canApply || !options.diff.summary.hasChanges;

    return renderShell(
        {
            currentPath: '/diff',
            driftStatus: options.diff.driftStatus,
            notice: options.notice,
            signOutPath: options.signOutPath,
            subtitle:
                'Preview how manager-owned access data will rewrite the generated runtime TOML while leaving the base file untouched.',
            title: 'Runtime Diff',
        },
        `<section class="detail-grid">
          <section class="panel stack">
            <div class="panel-head">
              <div>
                <h2>Managed access diff</h2>
                <p class="muted">Current comparison source: <span class="code">${escapeHtml(options.diff.diffSource)}</span></p>
              </div>
            </div>
            <div class="metric-grid">
              <div class="metric">
                <p class="metric-label">Runtime target</p>
                <p class="metric-value code">${escapeHtml(options.diff.runtimePlan.runtimeConfigHash.slice(0, 12))}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Changed sites</p>
                <p class="metric-value">${changedSiteCount}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Last applied</p>
                <p class="metric-value">${renderTimestamp(options.lastAppliedAt)}</p>
              </div>
            </div>
            ${
                !options.diff.summary.hasChanges
                    ? `<div class="empty-state">No managed access changes are pending right now.</div>`
                    : `<div class="diff-list">${options.diff.summary.changedSites
                          .map(
                              (siteDiff) => `<article class="diff-item">
                    <h3>${escapeHtml(siteDiff.siteId)}</h3>
                    ${renderPendingChanges(siteDiff)}
                  </article>`,
                          )
                          .join('')}</div>`
            }
          </section>
          <aside class="stack">
            <section class="panel panel-alt">
              <div class="panel-head">
                <div>
                  <h2>Validate and apply</h2>
                  <p class="muted">Validate re-parses the generated runtime TOML. Apply writes the runtime file and ${options.reloadConfigured ? 'requests a server reload when the write succeeds.' : 'leaves the reload step for the operator.'}</p>
                </div>
              </div>
              <div class="stack">
                <form method="post" action="/diff/validate">
                  <div class="button-row">
                    <button type="submit">Check pending changes</button>
                  </div>
                </form>
                <form method="post" action="/diff/apply">
                  <div class="button-row">
                    <button type="submit" ${applyDisabled ? 'disabled' : ''}>Publish changes</button>
                  </div>
                </form>
                <p class="muted">${
                    !options.canApply && options.diff.summary.hasChanges
                        ? 'Publish is disabled until the base config drift is synced.'
                        : options.diff.summary.hasChanges
                          ? `The next apply will update ${escapeHtml(formatCount(changedSiteCount, 'site'))}.`
                          : 'No pending changes are available to apply right now.'
                }</p>
              </div>
            </section>
            <section class="panel panel-alt">
              <div class="panel-head">
                <div>
                  <h2>Runtime files</h2>
                  <p class="muted">The manager writes a deterministic runtime file and keeps a last-known-good snapshot.</p>
                </div>
              </div>
              <dl class="definition-list">
                <div>
                  <dt>Generated runtime file</dt>
                  <dd class="code">${escapeHtml(options.runtimeConfigFile)}</dd>
                </div>
                <div>
                  <dt>Base config hash</dt>
                  <dd class="code">${escapeHtml(options.diff.runtimePlan.baseConfigHash)}</dd>
                </div>
                <div>
                  <dt>Runtime config hash</dt>
                  <dd class="code">${escapeHtml(options.diff.runtimePlan.runtimeConfigHash)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </section>`,
    );
}

export function renderManagerAuditPage(options: ManagerAuditPageOptions): string {
    const failedEvents = options.events.filter((event) => event.kind === 'apply-failed').length;
    const reloadedEvents = options.events.filter((event) => event.reloaded).length;
    const latestEventTimestamp = options.events[0]?.timestamp;

    return renderShell(
        {
            currentPath: '/audit',
            driftStatus: options.driftStatus,
            notice: options.notice,
            signOutPath: options.signOutPath,
            subtitle:
                'Review apply outcomes, rollback events, and which operator identity produced each write.',
            title: 'Audit Log',
        },
        `<section class="stack">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Audit summary</h2>
                <p class="muted">Signed audit entries are loaded from the manager-owned event log and its rotated archives.</p>
              </div>
            </div>
            <div class="metric-grid">
              <div class="metric">
                <p class="metric-label">Recorded events</p>
                <p class="metric-value">${options.events.length}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Failed applies</p>
                <p class="metric-value">${failedEvents}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Reloaded applies</p>
                <p class="metric-value">${reloadedEvents}</p>
              </div>
              <div class="metric">
                <p class="metric-label">Latest event</p>
                <p class="metric-value">${renderTimestamp(latestEventTimestamp)}</p>
              </div>
            </div>
          </section>
          <section class="panel stack">
            <div class="panel-head">
              <div>
                <h2>Recent events</h2>
                <p class="muted">Each event captures actor identity, changed sites, and runtime hashes for access mutations and apply attempts.</p>
              </div>
            </div>
            ${
                options.events.length === 0
                    ? `<div class="empty-state">No audit entries have been written yet.</div>`
                    : `<div class="event-list">${options.events
                          .map(
                              (event) => `<article class="event-item">
                    <div class="panel-head">
                      <div>
                        <h3>${escapeHtml(event.kind)}</h3>
                        <p class="event-meta">${renderTimestamp(event.timestamp)} · ${escapeHtml(renderAuditActorMeta(event))}</p>
                      </div>
                      <div class="status-row">${renderAuditEventBadges(event)}</div>
                    </div>
                    <p>${escapeHtml(event.message)}</p>
                    <dl class="hash-list event-facts">
                      <div>
                        <dt>Changed sites</dt>
                        <dd>${event.changedSiteIds.length === 0 ? 'none' : escapeHtml(event.changedSiteIds.join(', '))}</dd>
                      </div>
                      <div>
                        <dt>Base hash</dt>
                        <dd class="code">${escapeHtml(formatHashPreview(event.baseConfigHash))}</dd>
                      </div>
                      <div>
                        <dt>Runtime hash</dt>
                        <dd class="code">${escapeHtml(formatHashPreview(event.runtimeConfigHash))}</dd>
                      </div>
                      <div>
                        <dt>State hash</dt>
                        <dd class="code">${escapeHtml(formatHashPreview(event.stateHash))}</dd>
                      </div>
                    </dl>
                  </article>`,
                          )
                          .join('')}</div>`
            }
          </section>
        </section>`,
    );
}

export function renderManagerReconcilePage(options: ManagerReconcilePageOptions): string {
    const baseChangedSiteCount = options.reconcileStatus.base.preview?.changedSiteIds.length ?? 0;
    const runtimeChangedSiteCount =
        options.reconcileStatus.runtime.preview?.changedSiteIds.length ?? 0;

    const renderSourcePanel = (
        source: 'base' | 'runtime',
        label: string,
        description: string,
    ): string => {
        const entry = options.reconcileStatus[source];
        if (!entry.available || typeof entry.preview === 'undefined') {
            return `<article class="panel stack">
              <div class="panel-head">
                <div>
                  <h2>${escapeHtml(label)}</h2>
                  <p class="muted">${escapeHtml(description)}</p>
                </div>
              </div>
              <div class="notice notice-error" role="alert">${escapeHtml(entry.error ?? 'Preview unavailable.')}</div>
            </article>`;
        }

        return `<article class="panel stack">
          <div class="panel-head">
            <div>
              <h2>${escapeHtml(label)}</h2>
              <p class="muted">${escapeHtml(description)}</p>
            </div>
          </div>
          <div class="actions-inline">
            <p class="muted">${
                entry.preview.changedSiteIds.length > 0
                    ? `This will rewrite ${escapeHtml(formatCount(entry.preview.changedSiteIds.length, 'site'))} in manager-owned state and reset apply metadata.`
                    : 'This source already matches the current runtime file, but applying it still resets the manager apply baseline.'
            }</p>
            <form method="post" action="/reconcile/${source}">
              <button type="submit">Sync from ${escapeHtml(label.toLowerCase())}</button>
            </form>
          </div>
          ${renderManagedSiteDiffList(
              entry.preview.diff.changedSites,
              `No managed access changes would be written from the ${label.toLowerCase()}.`,
          )}
        </article>`;
    };

    return renderShell(
        {
            currentPath: '/reconcile',
            driftStatus: options.driftStatus,
            notice: options.notice,
            signOutPath: options.signOutPath,
            subtitle:
                'Compare saved manager access against the base and runtime files, then import or sync state without auto-applying the generated runtime TOML.',
            title: 'Sync Access State',
        },
        `<section class="detail-grid">
          <section class="stack">
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h2>State transfer summary</h2>
                  <p class="muted">Export a portable snapshot, import a replacement, or rebuild manager-owned access from either managed config file.</p>
                </div>
              </div>
              <div class="metric-grid">
                <div class="metric">
                  <p class="metric-label">Last applied</p>
                  <p class="metric-value">${renderTimestamp(options.lastAppliedAt)}</p>
                </div>
                <div class="metric">
                  <p class="metric-label">Base preview</p>
                  <p class="metric-value">${baseChangedSiteCount}</p>
                </div>
                <div class="metric">
                  <p class="metric-label">Runtime preview</p>
                  <p class="metric-value">${runtimeChangedSiteCount}</p>
                </div>
                <div class="metric">
                  <p class="metric-label">Snapshot version</p>
                  <p class="metric-value">v1</p>
                </div>
              </div>
            </section>
            ${renderSourcePanel(
                'base',
                'Base config',
                'Read saved access from magic-sso.base.toml and preserve the broader permissions list where possible.',
            )}
            ${renderSourcePanel(
                'runtime',
                'Runtime config',
                'Read saved access from magic-sso.runtime.toml to recover drift after direct runtime edits or state loss.',
            )}
          </section>
          <aside class="stack">
            <section class="panel panel-alt">
              <div class="panel-head">
                <div>
                  <h2>Portable export</h2>
                  <p class="muted">This JSON excludes last-applied timestamps and file hashes so the next validate or apply establishes a fresh baseline.</p>
                </div>
              </div>
              <textarea class="code" readonly>${escapeHtml(options.exportStateJson)}</textarea>
            </section>
            <section class="panel panel-alt">
              <div class="panel-head">
                <div>
                  <h2>Portable import</h2>
                  <p class="muted">Paste a snapshot to fully replace manager-owned state. This never auto-applies the runtime file or reloads the server.</p>
                </div>
              </div>
              <form method="post" action="/reconcile/import">
                <label for="snapshotJson">Snapshot JSON</label>
                <textarea id="snapshotJson" name="snapshotJson" class="code">${escapeHtml(options.importStateJson)}</textarea>
                <div class="button-row">
                  <button type="submit">Import snapshot</button>
                </div>
              </form>
            </section>
          </aside>
        </section>`,
    );
}

export function renderManagerLoginPage(options: ManagerLoginPageOptions): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <title>Unlock Manager | Magic Link SSO</title>
    <style>
      * {
        box-sizing: border-box;
      }

      :root {
        color-scheme: light dark;
        --paper: #f4eedf;
        --ink: #231d13;
        --muted: rgba(35, 29, 19, 0.72);
        --line: rgba(86, 67, 34, 0.18);
        --line-strong: rgba(86, 67, 34, 0.28);
        --error-bg: rgba(155, 44, 44, 0.12);
        --success-bg: rgba(47, 107, 67, 0.12);
        --warning-bg: rgba(138, 75, 15, 0.12);
        --field-bg: rgba(255, 255, 255, 0.54);
        --field-placeholder: rgba(35, 29, 19, 0.48);
        --accent: #8b5a2b;
        --accent-deep: #5e3c1e;
        --button-ink: #fff8f0;
        --paper-glow: rgba(255, 255, 255, 0.4);
        --paper-end: #e0cfb0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          radial-gradient(circle at top, var(--paper-glow), transparent 40%),
          linear-gradient(180deg, var(--paper) 0%, var(--paper-end) 100%);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --paper: #120f0b;
          --ink: #f5ecdc;
          --muted: rgba(245, 236, 220, 0.72);
          --line: rgba(224, 195, 136, 0.16);
          --line-strong: rgba(224, 195, 136, 0.24);
          --error-bg: rgba(252, 165, 165, 0.12);
          --success-bg: rgba(125, 211, 161, 0.12);
          --warning-bg: rgba(240, 179, 108, 0.12);
          --field-bg: rgba(255, 248, 240, 0.08);
          --field-placeholder: rgba(245, 236, 220, 0.5);
          --accent: #d7a164;
          --accent-deep: #f2c889;
          --button-ink: #1b140d;
          --paper-glow: rgba(255, 255, 255, 0.06);
          --paper-end: #251c13;
        }
      }

      body {
        margin: 0;
      }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.24em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.2rem, 4vw, 3.4rem);
        line-height: 0.98;
        letter-spacing: -0.05em;
      }

      .notice {
        padding: 0.95rem 1rem;
        border-radius: 1rem;
        border: 1px solid var(--line);
        margin-bottom: 1rem;
      }

      .notice-error {
        background: var(--error-bg);
      }

      .notice-success {
        background: var(--success-bg);
      }

      .notice-warning {
        background: var(--warning-bg);
      }

      label {
        display: block;
        margin-bottom: 0.4rem;
        font-weight: 700;
      }

      input[type="password"] {
        width: 100%;
        margin-bottom: 1rem;
        padding: 0.9rem 0.95rem;
        border: 1px solid var(--line-strong);
        border-radius: 1rem;
        color: inherit;
        background: var(--field-bg);
        font: inherit;
      }

      input::placeholder {
        color: var(--field-placeholder);
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.85rem;
        padding: 0.85rem 1rem;
        border: 1px solid var(--accent);
        border-radius: 999px;
        color: var(--button-ink);
        background: linear-gradient(135deg, var(--accent), var(--accent-deep));
        font: inherit;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main class="login-shell">
      <section class="login-card">
        <p class="eyebrow">Magic Link SSO Manager</p>
        <h1>Unlock dashboard</h1>
        <p class="login-copy">Legacy bearer-token mode still supports a direct manager unlock here. Gate-backed deployments skip this page entirely and rely on forwarded manager identity headers instead.</p>
        ${renderNotice(options.notice)}
        <form method="post" action="/login">
          <label for="managerToken">Operator token</label>
          <input id="managerToken" name="managerToken" type="password" autocomplete="current-password" required />
          <input type="hidden" name="returnTo" value="${escapeHtml(options.returnTo)}" />
          <div class="button-row">
            <button type="submit">Enter manager</button>
          </div>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

export function renderManagerErrorPage(options: ManagerErrorPageOptions): string {
    return renderShell(
        {
            currentPath: '/',
            subtitle:
                'The manager could not render this page cleanly. Review the message below and sync the local files before retrying.',
            title: `Error ${options.statusCode}`,
        },
        `<section class="panel stack">
          <div class="panel-head">
            <div>
              <h2>${escapeHtml(options.message)}</h2>
              ${
                  typeof options.details === 'string'
                      ? `<p class="muted">${escapeHtml(options.details)}</p>`
                      : ''
              }
            </div>
          </div>
          <div class="page-links">
            <a class="button-link button-link-secondary" href="/">Back to dashboard</a>
          </div>
        </section>`,
    );
}
