<script setup lang="ts">
import signinBadgeUrl from 'magic-sso-example-ui/assets/signin-page-badge.svg';
import type { AuthPayload } from '@magic-link-sso/nuxt';
import { buildLoginTarget } from '../utils/login';

const authState = useState<AuthPayload | null>('home-auth', () => null);
const config = useMagicSsoConfig();
const requestUrl = useRequestURL();
const loginTarget = computed(() =>
    buildLoginTarget(requestUrl.origin, '/', config.directUse, config.serverUrl),
);

if (import.meta.server) {
    authState.value = await useMagicSsoAuth();
}
</script>

<template>
    <main class="shell">
        <div class="card hero">
            <div class="hero-top">
                <img
                    :src="signinBadgeUrl"
                    alt="Sign-in flow badge"
                    class="badge"
                    width="144"
                    height="144"
                />
                <div>
                    <p class="eyebrow">Magic Link SSO</p>
                    <h1 class="title">Nuxt 4 SSR demo app for Magic Link sign-in.</h1>
                    <p class="copy">
                        Start the sign-in flow here, then open a protected route once your session
                        cookie is active.
                    </p>
                </div>
            </div>

            <div class="grid">
                <section class="panel">
                    <p class="panel-title">Session Status</p>
                    <p v-if="authState" class="panel-copy">
                        Signed in as <strong>{{ authState.email }}</strong
                        >. Your token is already active for protected routes.
                    </p>
                    <p v-else class="panel-copy">
                        You are not signed in yet. Start with the login page, then come back here to
                        see the authenticated state.
                    </p>
                </section>

                <section class="panel panel-dark">
                    <p class="panel-title">Quick Actions</p>
                    <div class="actions">
                        <template v-if="authState">
                            <a href="/protected" class="button button-light">Open Protected Page</a>
                            <form action="/logout" method="post">
                                <button type="submit" class="button button-secondary">
                                    Logout
                                </button>
                            </form>
                        </template>
                        <template v-else>
                            <a :href="loginTarget" class="button button-light">Login</a>
                            <a href="/protected" class="button button-secondary"
                                >Try Protected Page</a
                            >
                        </template>
                    </div>
                </section>
            </div>
        </div>
    </main>
</template>
