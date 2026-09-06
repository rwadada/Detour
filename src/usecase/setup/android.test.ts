import { describe, expect, it } from 'vitest';
import type { CertPairingServer, CertPairingSession } from '../ports/certPairingServer';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { CommandRunError } from '../ports/commandRunner';
import { parseAdbDevices, runAndroidCleanup, runAndroidDoctor, runAndroidSetup } from './android';
import type { SetupContext } from './types';

const ONE_DEVICE = 'List of devices attached\nABCD1234\tdevice\n';
const NONE_AUTHORIZED = 'List of devices attached\nABCD1234\tunauthorized\n';
const TWO_DEVICES = 'List of devices attached\nABCD1234\tdevice\nEFGH5678\tdevice\n';

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http is intentional here: nodeCertPairingServer.ts serves the CA cert over local HTTP by design (a phone can't yet trust anything to fetch it over HTTPS — that's exactly what this endpoint bootstraps), same as this test fixture's URL.
const PAIRING_URL = 'http://203.0.113.5:12345/detour-ca.crt';

describe('parseAdbDevices', () => {
  it('keeps only authorized devices', () => {
    expect(parseAdbDevices(ONE_DEVICE)).toEqual(['ABCD1234']);
    expect(parseAdbDevices(NONE_AUTHORIZED)).toEqual([]);
    expect(parseAdbDevices(TWO_DEVICES)).toEqual(['ABCD1234', 'EFGH5678']);
  });
});

function fakeRunner(handler: (command: string, args: string[]) => CommandResult): CommandRunner {
  return {
    async run(command, args) {
      return handler(command, args);
    },
  };
}

/** Never actually invoked in most tests below (no-`adb`-device is the only path that reaches it) — a fake that throws makes any accidental use loud instead of silently returning a bogus session. */
const unusedCertPairingServer: CertPairingServer = {
  async start() {
    throw new Error('certPairingServer.start() should not be called here');
  },
};

function fakeCertPairingServer(session: Partial<CertPairingSession> & { url: string }): CertPairingServer {
  return {
    async start() {
      return { waitForDownloadOrTimeout: async () => ({ downloaded: false }), ...session };
    },
  };
}

function ctxWith(runner: CommandRunner, overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    certPath: '/ca.pem',
    proxyHost: '203.0.113.5',
    proxyPort: 8080,
    runner,
    certPairingServer: unusedCertPairingServer,
    hostPlatform: 'darwin',
    explicitTarget: false,
    ...overrides,
  };
}

describe('runAndroidSetup', () => {
  it('pushes the cert, opens settings, and sets the proxy for the one connected device', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    expect(outcome.steps.map((s) => s.status)).toEqual(['manual', 'done']);
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 push /ca.pem /sdcard/Download/detour-ca.crt')).toBe(true);
    expect(
      calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy 203.0.113.5:8080'),
    ).toBe(true);
  });

  it('skips (not fails) with no device connected during a --target-less sweep, pointing at --target android', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const outcome = await runAndroidSetup(ctxWith(runner, { explicitTarget: false }));
    expect(outcome.steps).toEqual([
      { status: 'skipped', message: expect.stringContaining('detour setup --target android') },
    ]);
  });

  it('falls back to Wi-Fi/QR pairing with no device connected under an explicit --target android', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const certPairingServer = fakeCertPairingServer({ url: PAIRING_URL });
    const outcome = await runAndroidSetup(ctxWith(runner, { explicitTarget: true, certPairingServer }));

    expect(outcome.steps[0]).toEqual({
      status: 'manual',
      message: expect.stringContaining(PAIRING_URL),
      qrUrl: PAIRING_URL,
    });
    // fakeCertPairingServer defaults waitForDownloadOrTimeout to { downloaded: false }.
    expect(outcome.steps[1]!.status).toBe('skipped');
    expect(outcome.steps[2]).toEqual({ status: 'manual', message: expect.stringContaining('Modify network') });
  });

  it('calls onProgress with the QR step before waiting for the download, not only after', async () => {
    const events: string[] = [];
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const certPairingServer = fakeCertPairingServer({
      url: PAIRING_URL,
      waitForDownloadOrTimeout: async () => {
        events.push('waited');
        return { downloaded: false };
      },
    });
    const ctx = ctxWith(runner, {
      explicitTarget: true,
      certPairingServer,
      onProgress: (step) => {
        events.push(`progress:${step.qrUrl}`);
      },
    });

    await runAndroidSetup(ctx);

    expect(events).toEqual([`progress:${PAIRING_URL}`, 'waited']);
  });

  it('reports done (not skipped) when the QR pairing flow says the cert was downloaded', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const certPairingServer = fakeCertPairingServer({
      url: PAIRING_URL,
      waitForDownloadOrTimeout: async () => ({ downloaded: true }),
    });
    const outcome = await runAndroidSetup(ctxWith(runner, { explicitTarget: true, certPairingServer }));
    expect(outcome.steps[1]!.status).toBe('done');
  });

  it('reports a failed step (not a throw) when the pairing server itself fails to start', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const certPairingServer: CertPairingServer = {
      async start() {
        throw new Error('EADDRINUSE');
      },
    };
    const outcome = await runAndroidSetup(ctxWith(runner, { explicitTarget: true, certPairingServer }));
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('EADDRINUSE') }]);
  });

  it.each(['localhost', '127.0.0.1', '::1'])(
    'refuses to start Wi-Fi pairing with a loopback --host override (%s) instead of encoding an unreachable QR code',
    async (loopbackHost) => {
      const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
      const outcome = await runAndroidSetup(
        ctxWith(runner, { explicitTarget: true, proxyHost: loopbackHost, certPairingServer: unusedCertPairingServer }),
      );
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(loopbackHost) }]);
    },
  );

  it('fails cleanly with adb missing entirely', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"adb" not found — is it installed and on PATH?', 'adb', true);
      },
    };
    const outcome = await runAndroidSetup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('failed');
    expect(outcome.steps[0]!.message).toContain('not found');
  });
});

describe('runAndroidDoctor', () => {
  it('reports done across the board when the proxy matches', async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps.filter((s) => s.status === 'failed')).toEqual([]);
  });

  it('stops after the first failed step when adb itself is unusable', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"adb" not found — is it installed and on PATH?', 'adb', true);
      },
    };
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]!.status).toBe('failed');
  });

  it('stops after the device-connection check when no device is authorized', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps[1]!.status).toBe('failed');
  });

  it('reports a mismatched proxy as failed', async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: 'other-proxy:9999\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps[2]!.status).toBe('failed');
  });
});

describe('runAndroidCleanup', () => {
  it('resets the proxy to :0', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidCleanup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('done');
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy :0')).toBe(true);
  });

  it('fails cleanly with no device connected', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const outcome = await runAndroidCleanup(ctxWith(runner));
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('No authorized device') }]);
  });
});
