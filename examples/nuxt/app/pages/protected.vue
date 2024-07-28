<script setup lang="ts">
import protectedBadgeUrl from 'magic-sso-example-ui/assets/protected-page-badge.svg';
import type { AuthPayload } from '@magic-link-sso/nuxt';

definePageMeta({
    middleware: ['magic-sso-auth'],
});

const authState = useState<AuthPayload | null>('protected-auth', () => null);

if (import.meta.server) {
    authState.value = await useMagicSsoAuth();
}

useHead({
    title: 'Protected | Magic Link SSO Nuxt',
});
</script>

<template>
    <main class="shell">
        <div class="card hero">
            <div class="hero-top">
                <img
                    :src="protectedBadgeUrl"
                    alt="Protected area badge"
                    class="badge"
                    width="144"
                    height="144"
                />
                <div>
                    <p class="eyebrow">Protected Space</p>
                    <h1 class="title">Your Nuxt session is locked in and verified.</h1>
                    <p class="copy">
                        Hello,
                        <strong>{{ authState?.email ?? 'friend' }}</strong
                        >. This page is available only after a valid Magic Link SSO token is
                        confirmed.
                    </p>
                </div>
            </div>

            <div class="meta-row">
                <section class="panel panel-dark">
                    <p class="panel-title">Protected Route</p>
                    <p class="panel-copy">
                        This page uses the reusable `magic-sso-auth` middleware and the
                        `useMagicSsoAuth()` server helper.
                    </p>
                </section>
                <section class="panel">
                    <p class="panel-title">Next Steps</p>
                    <div class="actions">
                        <a href="/" class="button button-primary">Back Home</a>
                        <form action="/logout" method="post">
                            <button type="submit" class="button button-secondary">Logout</button>
                        </form>
                    </div>
                </section>
            </div>
        </div>
    </main>
</template>
