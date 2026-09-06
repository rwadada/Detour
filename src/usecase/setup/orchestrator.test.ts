import { describe, expect, it } from 'vitest';
import { SETUP_TARGETS } from '../../domain/setup/targets';
import type { CertPairingServer } from '../ports/certPairingServer';
import type { CommandRunner } from '../ports/commandRunner';
import { runForTarget, runTargets } from './orchestrator';

const noopRunner: CommandRunner = {
  async run() {
    return { stdout: '', stderr: '' };
  },
};

/** No test in this file exercises android's Wi-Fi/QR fallback (see android.test.ts for that) — a throwing stub makes any accidental use loud. */
const unusedCertPairingServer: CertPairingServer = {
  async start() {
    throw new Error('certPairingServer.start() should not be called here');
  },
};

function inputsWith(overrides: Partial<Parameters<typeof runForTarget>[2]> = {}) {
  return {
    certPath: '/ca.pem',
    proxyPort: 8080,
    runner: noopRunner,
    certPairingServer: unusedCertPairingServer,
    hostPlatform: 'darwin' as NodeJS.Platform,
    detectedLanAddresses: ['203.0.113.5'],
    explicitTarget: false,
    ...overrides,
  };
}

describe('runForTarget', () => {
  it('gives manual-only steps for an unautomated target (windows) regardless of host platform', async () => {
    const outcome = await runForTarget('setup', 'windows', inputsWith({ hostPlatform: 'linux' }));
    expect(outcome.steps.every((s) => s.status === 'manual')).toBe(true);
    expect(outcome.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('dispatches ios to its own automation regardless of host platform (Simulator tooling is local, not remote)', async () => {
    const outcome = await runForTarget('setup', 'ios', inputsWith({ hostPlatform: 'linux' }));
    // The fake runner returns empty stdout for everything, so `xcrun simctl`
    // parses as "no Simulator booted" — what matters here is that it was
    // dispatched to ios.ts's automation at all rather than the generic
    // unautomated/host-mismatch fallback.
    expect(outcome.steps[0]).toEqual({
      status: 'skipped',
      message: expect.stringContaining('No booted iOS Simulator'),
    });
  });

  it('skips an automated target on the wrong host and still offers manual steps', async () => {
    const outcome = await runForTarget('setup', 'mac', inputsWith({ hostPlatform: 'linux' }));
    expect(outcome.steps[0]!.status).toBe('skipped');
    expect(outcome.steps[0]!.message).toContain('linux');
    expect(outcome.steps.slice(1).every((s) => s.status === 'manual')).toBe(true);
  });

  it.each(['setup', 'doctor', 'cleanup'] as const)(
    'the wrong-host skip message names the actual mode (%s), not always "setup"',
    async (mode) => {
      const outcome = await runForTarget(mode, 'mac', inputsWith({ hostPlatform: 'linux' }));
      expect(outcome.steps[0]!.message).toContain(`automated ${mode} for mac`);
    },
  );

  it('runs real automation when the host platform matches', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command) {
        calls.push(command);
        return { stdout: 'An asterisk (*) denotes\nWi-Fi\n', stderr: '' };
      },
    };
    const outcome = await runForTarget('setup', 'mac', inputsWith({ hostPlatform: 'darwin', runner }));
    expect(calls).toContain('security');
    expect(calls).toContain('networksetup');
    expect(outcome.steps).toHaveLength(2);
  });

  it('reports a single failed step when a device target has no resolvable proxy address', async () => {
    const outcome = await runForTarget('setup', 'android', inputsWith({ detectedLanAddresses: [] }));
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('LAN IP') }]);
  });

  it('also requires a resolvable proxy address for doctor (it reports the proxy address, so needs to know it)', async () => {
    const outcome = await runForTarget('doctor', 'android', inputsWith({ detectedLanAddresses: [] }));
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('LAN IP') }]);
  });

  it("android's cleanup proceeds to real automation even with no resolvable proxy address (it never reads proxyHost)", async () => {
    const outcome = await runForTarget('cleanup', 'android', inputsWith({ detectedLanAddresses: [] }));
    // Reaches android.ts's real cleanup logic instead of bailing out on the
    // unresolvable address — the noop runner reports no adb device, so it
    // fails for that reason instead, proving proxy-host resolution didn't
    // block dispatch.
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('No authorized device') }]);
  });

  it.each(['setup', 'doctor'] as const)(
    "ios's %s proceeds to real Simulator automation even with no resolvable proxy address (Simulator automation never reads proxyHost)",
    async (mode) => {
      const outcome = await runForTarget(mode, 'ios', inputsWith({ detectedLanAddresses: [] }));
      // Dispatched to ios.ts's real automation rather than bailing out on
      // the unresolvable address — the noop runner reports no booted
      // Simulator, so that's what it reports instead, proving proxy-host
      // resolution didn't block dispatch the way it rightly does for
      // android's setup/doctor above.
      expect(outcome.steps[0]!.status).toBe('skipped');
      expect(outcome.steps[0]!.message).toContain('No booted iOS Simulator');
    },
  );

  it('ios\'s cleanup proceeds too, even with no resolvable proxy address (its "Turn the proxy off" wording needs no address at all)', async () => {
    const outcome = await runForTarget('cleanup', 'ios', inputsWith({ detectedLanAddresses: [] }));
    expect(outcome.steps[0]!.status).toBe('manual');
    expect(outcome.steps[0]!.message).toContain('Turn the proxy off');
  });

  it('prefixes doctor steps with "Verify:", unlike setup, and gives cleanup its own "Turn the proxy off" wording', async () => {
    const setupOutcome = await runForTarget('setup', 'windows', inputsWith());
    const doctorOutcome = await runForTarget('doctor', 'windows', inputsWith());
    const cleanupOutcome = await runForTarget('cleanup', 'windows', inputsWith());
    expect(setupOutcome.steps[0]!.message.startsWith('Verify:')).toBe(false);
    expect(doctorOutcome.steps[0]!.message.startsWith('Verify:')).toBe(true);
    expect(cleanupOutcome.steps[0]!.message).toContain('Turn the proxy off');
  });
});

describe('runTargets', () => {
  it('covers every declared target, in order, when none is given', async () => {
    const reports = await runTargets('doctor', undefined, inputsWith());
    expect(reports.map((r) => r.target)).toEqual([...SETUP_TARGETS]);
  });

  it('covers only the requested target when one is given', async () => {
    const reports = await runTargets('doctor', ['linux'], inputsWith({ hostPlatform: 'linux' }));
    expect(reports.map((r) => r.target)).toEqual(['linux']);
  });
});
