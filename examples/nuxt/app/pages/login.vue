<script setup lang="ts">
import signinBadgeUrl from 'magic-sso-example-ui/assets/signin-page-badge.svg';
import { buildVerifyUrl, normaliseReturnUrl } from '../utils/login';

interface SignInResult {
    success: boolean;
    message: string;
    otpChallengeId?: string;
    otpExpiresInSeconds?: number;
    otpLength?: number;
}

const route = useRoute();
const requestUrl = useRequestURL();
const email = ref('');
const pending = ref(false);
const otpCode = ref('');
const otpPending = ref(false);
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
const isConfirmation = computed(
    () => result.value?.success === true || typeof result.value?.otpChallengeId === 'string',
);
const hasOtpChallenge = computed(() => typeof result.value?.otpChallengeId === 'string');
const emailDescription = computed(() =>
    hasError.value ? 'signin-help signin-feedback' : 'signin-help',
);
const verifyUrl = computed(() => buildVerifyUrl(requestUrl.origin, returnUrl.value));
const loginCopy = computed(() =>
    isConfirmation.value
        ? {
              help: 'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.',
              title: 'Check your email',
          }
        : { help: "We'll email you a sign-in link.", title: 'Sign in' },
);
const submitLabel = computed(() => (pending.value ? 'Sending magic link...' : 'Send magic link'));
const otpSubmitLabel = computed(() => (otpPending.value ? 'Signing in…' : 'Sign in with code'));
const otpLength = computed(() => result.value?.otpLength);
const otpPlaceholder = computed(() => (otpLength.value === 6 ? '123456' : undefined));

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

async function submitOtp(): Promise<void> {
    if (typeof result.value?.otpChallengeId !== 'string') {
        return;
    }
    otpPending.value = true;
    try {
        await $fetch('/verify-email/otp', {
            method: 'POST',
            body: { challengeId: result.value.otpChallengeId, code: otpCode.value },
        });
        await navigateTo(returnUrl.value, { external: true });
    } catch {
        result.value = {
            ...result.value,
            success: false,
            message: 'Invalid or expired code.',
        };
    } finally {
        otpPending.value = false;
    }
}

function useDifferentEmail(): void {
    otpCode.value = '';
    result.value = null;
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
            <h1 id="login-title" class="login-title">
                {{ loginCopy.title }}
            </h1>
            <p id="signin-help" class="login-copy">
                {{ loginCopy.help }}
            </p>

            <form
                v-if="!isConfirmation"
                class="login-form"
                aria-describedby="signin-help"
                @submit.prevent="submitForm"
            >
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
                        <span>{{ submitLabel }}</span>
                    </button>
                    <NuxtLink to="/" class="button button-secondary">Back Home</NuxtLink>
                </div>
            </form>
            <div v-else class="confirmation-panel" role="status" aria-live="polite">
                <form
                    v-if="hasOtpChallenge"
                    class="login-form"
                    aria-describedby="otp-help"
                    @submit.prevent="submitOtp"
                >
                    <label class="field-label" for="otp-code">One-time code</label>
                    <input
                        id="otp-code"
                        v-model="otpCode"
                        class="field-input"
                        type="text"
                        autocomplete="one-time-code"
                        inputmode="numeric"
                        pattern="[0-9]*"
                        :minlength="otpLength"
                        :maxlength="otpLength"
                        :placeholder="otpPlaceholder"
                        aria-describedby="otp-help"
                        required
                    />
                    <p id="otp-help" class="login-copy">
                        You can also enter the one-time code from the email here.
                    </p>
                    <div class="login-actions">
                        <button
                            class="button button-primary button-submit"
                            type="submit"
                            :disabled="otpPending"
                        >
                            {{ otpSubmitLabel }}
                        </button>
                        <button
                            class="button button-secondary"
                            type="button"
                            @click="useDifferentEmail"
                        >
                            Use a different email
                        </button>
                    </div>
                </form>
                <div v-else class="login-actions">
                    <button
                        class="button button-secondary"
                        type="button"
                        @click="useDifferentEmail"
                    >
                        Use a different email
                    </button>
                </div>
            </div>
            <p v-if="hasError" id="signin-feedback" class="message message-error" role="alert">
                {{ result?.message }}
            </p>
        </section>
    </main>
</template>
