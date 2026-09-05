import { describe, expect, it } from 'vitest';
import { manualSetupInstructions } from './instructions';
import { SETUP_TARGETS } from './targets';

const ctx = { certPath: '/home/user/.detour/certs/certs/ca.pem', proxyHost: '203.0.113.5', proxyPort: 8080 };

describe('manualSetupInstructions', () => {
  it('returns at least a cert step and a proxy step for every target', () => {
    for (const target of SETUP_TARGETS) {
      const steps = manualSetupInstructions(target, ctx);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      for (const step of steps) expect(step.length).toBeGreaterThan(0);
    }
  });

  it('interpolates the cert path and proxy address into every target', () => {
    for (const target of SETUP_TARGETS) {
      const steps = manualSetupInstructions(target, ctx).join('\n');
      expect(steps).toContain(ctx.certPath);
      expect(steps).toContain(`${ctx.proxyHost} / ${ctx.proxyPort}`);
    }
  });
});
