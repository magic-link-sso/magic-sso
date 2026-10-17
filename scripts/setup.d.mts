export interface StarterOptions {
    path: 'gate' | 'sdk';
    emails: string[];
    output?: string;
    serverOrigin?: string;
    appOrigin?: string;
    upstreamUrl?: string;
    siteId?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPassword?: string;
    smtpSecure?: boolean;
    emailFrom?: string;
    serverPort?: number;
    appPort?: number;
    trustProxy?: boolean;
}
export function createStarterFiles(options: StarterOptions): Record<string, string>;
export function writeStarter(options: StarterOptions): string;
export function runSetup(argv: string[]): Promise<number>;
