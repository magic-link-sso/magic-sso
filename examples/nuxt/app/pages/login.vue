<script setup lang="ts">
import signinBadgeUrl from 'magic-sso-example-ui/assets/signin-page-badge.svg';
import { buildVerifyUrl, normaliseReturnUrl } from '../utils/login';

interface SignInResult {
    success: boolean;
    message: string;
}

const route = useRoute();
const requestUrl = useRequestURL();
const email = ref('');
const pending = ref(false);
const result = ref<SignInResult | null>(null);
const returnUrl = computed(() => normaliseReturnUrl(route.query.returnUrl, requestUrl.origin));
const scope = computed(() => {
    const requestedScope = Array.isArray(route.query.scope)
        ? route.query.scope[0]
        : route.query.scope;
    return typeof requestedScope === 'string' && requestedScope.trim().length > 0
        ? requestedScope.trim()
        : undefined;
});
const hasError = computed(() => result.value?.success === false);
const emailDescription = computed(() =>
    hasError.value ? 'signin-help signin-feedback' : 'signin-help',
);
const verifyUrl = computed(() => buildVerifyUrl(requestUrl.origin, returnUrl.value));

useHead({
    title: 'Sign In | Magic Link SSO Nuxt',
});

async function submitForm(): Promise<void> {
    pending.value = true;

    try {
        const response = await $fetch<SignInResult>('/api/signin', {
            method: 'POST',
            body: {
                email: email.value,
                returnUrl: returnUrl.value,
                verifyUrl: verifyUrl.value,
                scope: scope.value,
            },
        });
        result.value = response;
    } catch {
        result.value = {
            success: false,
            message: 'Failed to send verification email.',
        };
    } finally {
        pending.value = false;
    }
}
</script>

<template>
    <main class="login-shell">
        <a class="skip-link" href="#login-card">Skip to sign-in form</a>
        <section id="login-card" class="login-panel" aria-labelledby="login-title">
            <img
                :src="signinBadgeUrl"
                alt="Sign-in flow badge"
                class="badge login-badge"
                width="144"
                height="144"
            />
            <p class="eyebrow">Sign In</p>
            <h1 id="login-title" class="login-title">Sign in</h1>
            <p id="signin-help" class="login-copy">We&apos;ll email you a sign-in link.</p>

            <form class="login-form" aria-describedby="signin-help" @submit.prevent="submitForm">
                <label class="field-label" for="email">Email</label>
                <input
                    id="email"
                    v-model="email"
                    class="field-input"
                    type="email"
                    autocomplete="email"
                    inputmode="email"
                    placeholder="you@example.com"
                    spellcheck="false"
                    :aria-describedby="emailDescription"
                    :aria-invalid="hasError || undefined"
                    required
                />
                <div class="login-actions">
                    <button
                        class="button button-primary button-submit"
                        type="submit"
                        :disabled="pending"
                        :aria-disabled="pending"
                    >
                        <span
                            class="button-spinner"
                            :class="{ 'button-spinner-visible': pending }"
                            aria-hidden="true"
                        />
                        <span>{{ pending ? 'Sending magic link...' : 'Send magic link' }}</span>
                    </button>
                    <NuxtLink to="/" class="button button-secondary">Back Home</NuxtLink>
                </div>
                <p
                    v-if="result?.success"
                    id="signin-feedback"
                    class="message message-success"
                    role="status"
                    aria-live="polite"
                >
                    {{ result.message }}
                </p>
                <p v-if="hasError" id="signin-feedback" class="message message-error" role="alert">
                    {{ result.message }}
                </p>
            </form>
        </section>
    </main>
</template>
