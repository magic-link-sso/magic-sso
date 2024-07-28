import { createE2eConfig } from './playwright.base.ts';

export default createE2eConfig({
    directUse: true,
    testMatch: /example-apps-magic-link\.direct\.spec\.ts/u,
});
