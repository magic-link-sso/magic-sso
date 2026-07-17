import { describe, expect, it } from 'vitest';
import { extractEmailOtp, type SinkMessage } from './helpers/mail-sink.js';

function createMessage(text: string): SinkMessage {
    return {
        html: '',
        id: 'message-1',
        subject: 'Sign in',
        text,
        to: ['user@example.com'],
    };
}

describe('email OTP extraction', () => {
    it('extracts only the configured-length code from the explicit OTP block', () => {
        const message = createMessage(
            [
                'Reference: 987654',
                '',
                'Enter this one-time code in the app you already opened:',
                '123456',
            ].join('\n'),
        );

        expect(extractEmailOtp(message, 6)).toBe('123456');
    });

    it('rejects a longer digit sequence without including it in the error', () => {
        const message = createMessage(
            'Enter this one-time code in the app you already opened:\n1234567',
        );

        expect(() => extractEmailOtp(message, 6)).toThrow(
            'No 6-digit OTP found in email message message-1.',
        );
        expect(() => extractEmailOtp(message, 6)).not.toThrow('1234567');
    });
});
