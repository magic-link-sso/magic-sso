import { createE2eConfig } from './playwright.base.ts';

export default createE2eConfig({
    directUse: false,
    behindProxy: true,
    testMatch: /example-apps-magic-link\.indirect\.spec\.ts/u,
});
