import { describe, expect, it } from 'vitest';
import { manualSteps } from './manualSteps';

const ctx = { certPath: '/ca.pem', proxyHost: '203.0.113.5', proxyPort: 8080 };

describe('manualSteps', () => {
  it('leaves setup steps unprefixed', () => {
    const steps = manualSteps('setup', 'windows', ctx);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status === 'manual')).toBe(true);
    expect(steps.every((s) => !s.message.startsWith('Verify:') && !s.message.startsWith('Undo manually:'))).toBe(true);
  });

  it('prefixes doctor steps with "Verify:"', () => {
    for (const step of manualSteps('doctor', 'windows', ctx)) expect(step.message.startsWith('Verify: ')).toBe(true);
  });

  it('prefixes cleanup steps with "Undo manually:"', () => {
    for (const step of manualSteps('cleanup', 'windows', ctx)) {
      expect(step.message.startsWith('Undo manually: ')).toBe(true);
    }
  });
});
