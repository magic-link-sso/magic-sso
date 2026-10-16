// SPDX-License-Identifier: MIT

/** Match the adapter's configured-origin and explicit proxy-trust policy during SSR. */
export function useAppOrigin(): string {
    const config = useMagicSsoConfig();
    const requestUrl = useRequestURL({
        xForwardedHost: config.trustProxy,
        xForwardedProto: config.trustProxy,
    });
    return config.publicOrigin || requestUrl.origin;
}
