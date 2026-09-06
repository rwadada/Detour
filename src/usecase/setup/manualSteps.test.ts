import { describe, expect, it } from 'vitest';
import { SETUP_TARGETS } from '../../domain/setup/targets';
import { manualSteps } from './manualSteps';

const ctx = { certPath: '/ca.pem', proxyHost: '203.0.113.5', proxyPort: 8080 };

describe('manualSteps', () => {
  it('leaves setup steps unprefixed and includes both the cert-trust and proxy-config instructions', () => {
    const steps = manualSteps('setup', 'windows', ctx);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.status === 'manual')).toBe(true);
    expect(steps.every((s) => !s.message.startsWith('Verify:') && !s.message.startsWith('Undo manually:'))).toBe(true);
  });

  it('prefixes doctor steps with "Verify:" and still includes both instructions', () => {
    const steps = manualSteps('doctor', 'windows', ctx);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.message.startsWith('Verify: ')).toBe(true);
  });

  it('prefixes cleanup\'s one step with "Undo manually:" and never mentions cert trust — cleanup never touches it', () => {
    for (const target of SETUP_TARGETS) {
      const steps = manualSteps('cleanup', target, ctx);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.message.startsWith('Undo manually: ')).toBe(true);
      expect(steps[0]!.message).not.toContain('Trust the CA cert');
    }
  });
});
