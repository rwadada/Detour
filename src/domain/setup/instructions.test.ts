import { describe, expect, it } from 'vitest';
import { manualSetupInstructions } from './instructions';
import { SETUP_TARGETS } from './targets';

const ctx = { certPath: '/home/user/.detour/certs/certs/ca.pem', proxyHost: '203.0.113.5', proxyPort: 8080 };

describe('manualSetupInstructions', () => {
  it('returns a non-empty cert-trust, proxy-config, and proxy-cleanup instruction for every target', () => {
    for (const target of SETUP_TARGETS) {
      const instructions = manualSetupInstructions(target, ctx);
      expect(instructions.certTrust.length).toBeGreaterThan(0);
      expect(instructions.proxyConfig.length).toBeGreaterThan(0);
      expect(instructions.proxyCleanup.length).toBeGreaterThan(0);
    }
  });

  it('interpolates the cert path into certTrust and the proxy address into proxyConfig for every target', () => {
    for (const target of SETUP_TARGETS) {
      const instructions = manualSetupInstructions(target, ctx);
      expect(instructions.certTrust).toContain(ctx.certPath);
      expect(instructions.proxyConfig).toContain(`${ctx.proxyHost} / ${ctx.proxyPort}`);
    }
  });

  it('proxyCleanup describes turning the proxy off, never phrased as configuring/enabling it, for every target', () => {
    for (const target of SETUP_TARGETS) {
      const { proxyCleanup } = manualSetupInstructions(target, ctx);
      expect(proxyCleanup).toContain('Turn the proxy off');
      expect(proxyCleanup).not.toContain('Configure the proxy');
    }
  });
});
