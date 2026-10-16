// SPDX-License-Identifier: MIT

/** Runner-independent observable contract; framework and browser work stays in the driver. */
export interface SignInFlowSession {
    url: string;
    email: string;
    siteId: string;
    jti: string;
    httpOnly: boolean;
    sameSite: string;
}

export interface SignInFlowScenario {
    method: 'magic-link' | 'otp';
    appOrigin: string;
    email: string;
    siteId: string;
    returnPath: string;
}

export interface SignInFlowDriver {
    requestVerification(method: SignInFlowScenario['method'], returnPath: string): Promise<string>;
    hasSession(): Promise<boolean>;
    verify(method: SignInFlowScenario['method'], credential: string): Promise<void>;
    readSession(returnPath: string): Promise<SignInFlowSession>;
    revisit(returnPath: string): Promise<void>;
    logout(): Promise<void>;
    expectSignInRequired(returnPath: string): Promise<void>;
}

export function signInReturnPaths(protectedPath: string): readonly string[] {
    return [
        protectedPath,
        `${protectedPath}?status=pending&page=3&q=a%2Bb%20%26%20c&tag=one&tag=two`,
    ];
}

/** URLSearchParams may serialize spaces as +; preserve values, ordering and duplicates. */
export function canonicalFlowUrl(value: string): string {
    const url = new URL(value);
    url.search = url.searchParams.toString();
    return url.toString();
}

function requireContract(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Sign-in flow contract: ${message}`);
    }
}

function assertSession(session: SignInFlowSession, scenario: SignInFlowScenario): void {
    requireContract(
        canonicalFlowUrl(session.url) ===
            canonicalFlowUrl(`${scenario.appOrigin}${scenario.returnPath}`),
        'return to the full original URL, including its query values and repeated parameters',
    );
    requireContract(session.email === scenario.email, 'establish the verified identity');
    requireContract(session.siteId === scenario.siteId, 'bind the session to the requested site');
    requireContract(session.jti.length > 0, 'establish a session with an identifier');
    requireContract(
        session.httpOnly && session.sameSite === 'Lax',
        'use an HttpOnly, SameSite=Lax application cookie',
    );
}

/** Email proof must precede a reusable application session; logout must protect the URL again. */
export async function runSignInFlowContract(
    driver: SignInFlowDriver,
    scenario: SignInFlowScenario,
): Promise<void> {
    const credential = await driver.requestVerification(scenario.method, scenario.returnPath);
    requireContract(
        !(await driver.hasSession()),
        'do not create an application session before verification',
    );
    await driver.verify(scenario.method, credential);
    const initial = await driver.readSession(scenario.returnPath);
    assertSession(initial, scenario);
    await driver.revisit(scenario.returnPath);
    const reused = await driver.readSession(scenario.returnPath);
    assertSession(reused, scenario);
    requireContract(
        reused.jti === initial.jti,
        'reuse the application session on subsequent requests',
    );
    await driver.logout();
    requireContract(!(await driver.hasSession()), 'clear the application cookie on logout');
    await driver.expectSignInRequired(scenario.returnPath);
    requireContract(
        !(await driver.hasSession()),
        'keep the protected URL inaccessible after logout',
    );
}
