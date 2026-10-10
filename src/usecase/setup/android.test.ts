import { describe, expect, it } from 'vitest';
import type { CertPairingServer, CertPairingSession } from '../ports/certPairingServer';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { CommandRunError } from '../ports/commandRunner';
import type { DeviceChoice, DevicePicker } from '../ports/devicePicker';
import {
  classifyDeviceKind,
  describeProxyWriteFailure,
  isWifiActiveNetwork,
  parseAdbDevices,
  runAndroidCleanup,
  runAndroidDoctor,
  runAndroidSetup,
} from './android';
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

/** Never actually invoked in most tests below (only one connected device — or zero — is the common case) — `isInteractive: false` keeps `requireOneDevice` from ever reaching `pick()` at all if a test somehow does end up with multiple devices, and `pick` itself still throws to make that loud rather than silently resolving a bogus pick. */
const unusedDevicePicker: DevicePicker = {
  isInteractive: () => false,
  async pick() {
    throw new Error('devicePicker.pick() should not be called here');
  },
};

/** Resolves to `serial` regardless of `choices` — the "an interactive terminal picked this one" case. */
function fakeDevicePicker(serial: string | undefined): DevicePicker {
  return {
    isInteractive: () => true,
    async pick() {
      return serial;
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
    devicePicker: unusedDevicePicker,
    hostPlatform: 'darwin',
    explicitTarget: false,
    ...overrides,
  };
}

const SECURE_SETTINGS_TRACE = [
  "Exception occurred while executing 'put':",
  'java.lang.SecurityException: Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS',
  '\tat com.android.providers.settings.SettingsProvider.enforceWritePermission(SettingsProvider.java:2622)',
  '\tat android.os.Binder.execTransact(Binder.java:1268)',
].join('\n');

describe('describeProxyWriteFailure', () => {
  it('turns the WRITE_SECURE_SETTINGS stack trace into a short message that names the fix', () => {
    const message = describeProxyWriteFailure(new CommandRunError(SECURE_SETTINGS_TRACE, 'adb'));
    expect(message).toContain('USB debugging (Security settings)'); // Xiaomi
    expect(message).toContain('Disable permission monitoring'); // OPPO / OnePlus / Realme
    expect(message).toContain('Disable system optimization'); // newer ColorOS
    expect(message).toContain('Proxy → Manual');
    expect(message).not.toContain('java.lang');
    expect(message).not.toContain('\n');
  });

  it('leaves every other failure as the runner worded it', () => {
    expect(describeProxyWriteFailure(new CommandRunError('device offline', 'adb'))).toBe(
      "Couldn't set the device's proxy: device offline",
    );
    expect(describeProxyWriteFailure('plain string')).toBe("Couldn't set the device's proxy: plain string");
  });
});

describe('runAndroidSetup', () => {
  it('reports the secure-settings refusal as a failed step with the short hint, after the cert step still went through', async () => {
    const runner = fakeRunner((command, args) => {
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.join(' ').includes('settings put global http_proxy'))
        throw new CommandRunError(SECURE_SETTINGS_TRACE, 'adb');
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    expect(outcome.steps.map((s) => s.status)).toEqual(['manual', 'failed']);
    expect(outcome.steps[1]?.message).toContain('USB debugging (Security settings)');
    expect(outcome.steps[1]?.message).not.toContain('java.lang');
  });

  it('pushes the cert, opens settings, and sets the proxy for the one connected device', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    expect(outcome.steps.map((s) => s.status)).toEqual(['manual', 'done']);
    expect(
      calls.some((c) => c.join(' ') === 'adb -s ABCD1234 push /ca.pem /sdcard/Download/Detour/detour-ca.crt'),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.join(' ') ===
          'adb -s ABCD1234 shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/Detour/detour-ca.crt',
      ),
    ).toBe(true);
    // A USB device reaches this machine through `adb reverse`, not over the LAN.
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 reverse --no-rebind tcp:8080 tcp:8080')).toBe(true);
    expect(
      calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy localhost:8080'),
    ).toBe(true);
    expect(calls.some((c) => c.join(' ').includes('203.0.113.5:8080'))).toBe(false);
  });

  it('says in the done step that it goes through adb reverse over USB', async () => {
    const runner = fakeRunner((command, args) =>
      command === 'adb' && args[0] === 'devices' ? { stdout: ONE_DEVICE, stderr: '' } : { stdout: '', stderr: '' },
    );
    const outcome = await runAndroidSetup(ctxWith(runner));
    expect(outcome.steps.at(-1)?.message).toMatch(/localhost:8080.*adb reverse.*USB/);
  });

  it('falls back to the LAN address for a device that is reached over Wi-Fi (adb over the network), without adb reverse', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') {
        return { stdout: 'List of devices attached\n192.168.1.20:41234\tdevice\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    expect(calls.some((c) => c.includes('reverse'))).toBe(false);
    expect(
      calls.some(
        (c) => c.join(' ') === 'adb -s 192.168.1.20:41234 shell settings put global http_proxy 203.0.113.5:8080',
      ),
    ).toBe(true);
    expect(outcome.steps.map((s) => s.status)).toEqual(['manual', 'done']);
  });

  it('does not treat a wireless-debugging (mDNS) device name as USB: LAN address, no adb reverse', async () => {
    const serial = 'adb-35121FDJH000R8-xyMD0H._adb-tls-connect._tcp';
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') {
        return { stdout: `List of devices attached\n${serial}\tdevice\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await runAndroidSetup(ctxWith(runner));

    expect(calls.some((c) => c.includes('reverse'))).toBe(false);
    expect(
      calls.some((c) => c.join(' ') === `adb -s ${serial} shell settings put global http_proxy 203.0.113.5:8080`),
    ).toBe(true);
  });

  it('does not take over a port another tool already forwards: --no-rebind makes it fail, so it falls back to the LAN address', async () => {
    const runner = fakeRunner((command, args) => {
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('reverse')) {
        if (!args.includes('--no-rebind')) return { stdout: '', stderr: '' }; // would have silently rebound
        throw new CommandRunError("adb: error: cannot rebind existing socket 'tcp:8080'", 'adb');
      }
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidSetup(ctxWith(runner));
    expect(outcome.steps.some((s) => s.message.includes("Couldn't set up `adb reverse`"))).toBe(true);
  });

  describe('when --no-rebind refuses because a reverse is already on the proxy port', () => {
    const REFUSAL = "adb: error: cannot rebind existing socket 'tcp:8080'";

    function runnerWithExistingReverse(list: string) {
      const calls: string[][] = [];
      const runner = fakeRunner((command, args) => {
        calls.push([command, ...args]);
        if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
        if (args.includes('--no-rebind')) throw new CommandRunError(REFUSAL, 'adb');
        if (args.includes('--list')) return { stdout: list, stderr: '' };
        return { stdout: '', stderr: '' };
      });
      return { runner, calls };
    }

    it('counts a reverse that is already exactly tcp:<port> -> tcp:<port> (set by hand, or by an earlier run) as in place', async () => {
      // As a real device printed it: the first column is the transport (`UsbFfs`), not the serial.
      const { runner, calls } = runnerWithExistingReverse('UsbFfs tcp:8080 tcp:8080\n');

      const outcome = await runAndroidSetup(ctxWith(runner));

      expect(
        calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy localhost:8080'),
      ).toBe(true);
      expect(outcome.steps.some((s) => s.message.includes("Couldn't set up `adb reverse`"))).toBe(false);
      expect(outcome.steps.at(-1)).toMatchObject({ status: 'done', message: expect.stringContaining('adb reverse') });
    });

    it('does not count a different port, or no reverse at all, and says what adb said', async () => {
      for (const list of ['UsbFfs tcp:9000 tcp:9000\n', '']) {
        const { runner, calls } = runnerWithExistingReverse(list);

        const outcome = await runAndroidSetup(ctxWith(runner));

        expect(calls.some((c) => c.join(' ').includes('localhost:8080'))).toBe(false);
        const warning = outcome.steps.find((s) => s.message.includes("Couldn't set up `adb reverse`"));
        expect(warning?.message).toContain(REFUSAL);
        expect(warning?.message).toContain('203.0.113.5:8080');
      }
    });

    it('when the port is forwarded to somewhere else, says where and gives the command that clears it', async () => {
      const { runner, calls } = runnerWithExistingReverse('UsbFfs tcp:8080 tcp:3000\n');

      const outcome = await runAndroidSetup(ctxWith(runner));

      expect(calls.some((c) => c.join(' ').includes('localhost:8080'))).toBe(false);
      const warning = outcome.steps.find((s) => s.message.includes("Couldn't set up `adb reverse`"));
      expect(warning?.message).toContain('already forwarded to tcp:3000');
      expect(warning?.message).toContain('adb -s ABCD1234 reverse --remove tcp:8080');
      expect(warning?.message).toContain('203.0.113.5:8080'); // and it still says it fell back
    });
  });

  it('falls back to the LAN address — and says why — when adb reverse fails on a USB device', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('reverse')) throw new CommandRunError('error: closed', 'adb');
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    expect(
      calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy 203.0.113.5:8080'),
    ).toBe(true);
    expect(calls.some((c) => c.join(' ').includes('localhost:8080'))).toBe(false);
    const warning = outcome.steps.find((s) => s.message.includes("Couldn't set up `adb reverse`"));
    expect(warning?.status).toBe('manual');
    expect(warning?.message).toContain('VPN');
  });

  it('still succeeds when the best-effort MediaStore re-scan broadcast itself throws (push and Security settings still ran)', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('MEDIA_SCANNER_SCAN_FILE')) throw new Error('adb: device offline');
      return { stdout: '', stderr: '' };
    });

    const outcome = await runAndroidSetup(ctxWith(runner));

    // Same result as the happy-path test above — the broadcast failure
    // never surfaces as a `failed` step.
    expect(outcome.steps.map((s) => s.status)).toEqual(['manual', 'done']);
    // ...and the push/Security-settings calls after the broadcast still ran.
    expect(
      calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell am start -a android.settings.SECURITY_SETTINGS'),
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

  it.each(['localhost', '127.0.0.1', '127.0.1.1', '::1', '0.0.0.0'])(
    'refuses to start Wi-Fi pairing with a loopback --host override (%s) instead of encoding an unreachable QR code',
    async (loopbackHost) => {
      const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
      const outcome = await runAndroidSetup(
        ctxWith(runner, { explicitTarget: true, proxyHost: loopbackHost, certPairingServer: unusedCertPairingServer }),
      );
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(loopbackHost) }]);
    },
  );

  it.each(['localhost', '127.0.0.1', '127.0.1.1', '::1', '0.0.0.0'])(
    'refuses a loopback --host override (%s) even with an adb device connected, instead of pointing the device at itself',
    async (loopbackHost) => {
      const calls: string[][] = [];
      const runner = fakeRunner((command, args) => {
        calls.push([command, ...args]);
        return { stdout: ONE_DEVICE, stderr: '' };
      });
      const outcome = await runAndroidSetup(ctxWith(runner, { proxyHost: loopbackHost }));
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(loopbackHost) }]);
      // Fails before ever touching the device — no push/proxy commands sent.
      expect(calls).toEqual([]);
    },
  );

  it.each(['2001:db8::1', '10.0.0.2:8080'])(
    'refuses a --host value containing a colon (%s) — an unbracketed IPv6 literal or an accidental host:port pair',
    async (badHost) => {
      const calls: string[][] = [];
      const runner = fakeRunner((command, args) => {
        calls.push([command, ...args]);
        return { stdout: ONE_DEVICE, stderr: '' };
      });
      const outcome = await runAndroidSetup(ctxWith(runner, { proxyHost: badHost }));
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(badHost) }]);
      expect(calls).toEqual([]);
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

describe('runAndroidDoctor — a USB device set up through adb reverse', () => {
  function doctorRunner(opts: { proxy: string; reverseList: string }) {
    return fakeRunner((command, args) => {
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.join(' ').includes('settings get global http_proxy')) return { stdout: `${opts.proxy}\n`, stderr: '' };
      if (args.includes('reverse') && args.includes('--list')) return { stdout: opts.reverseList, stderr: '' };
      return { stdout: '', stderr: '' };
    });
  }

  it('points out that a USB device on the LAN address goes through the network, and that setup fixes it', async () => {
    const outcome = await runAndroidDoctor(ctxWith(doctorRunner({ proxy: '203.0.113.5:8080', reverseList: '' })));

    // Not a failure: it works while this machine is on the same network.
    expect(outcome.steps.some((s) => s.status === 'failed')).toBe(false);
    const hint = outcome.steps.find((s) => s.message.includes('over the network'));
    expect(hint?.status).toBe('manual');
    expect(hint?.message).toContain('detour setup --target android');
    expect(hint?.message).toContain('VPN');
  });

  it('says nothing of the kind once the device is on localhost through the reverse', async () => {
    const outcome = await runAndroidDoctor(
      ctxWith(doctorRunner({ proxy: 'localhost:8080', reverseList: 'UsbFfs tcp:8080 tcp:8080\n' })),
    );
    expect(outcome.steps.some((s) => s.message.includes('over the network'))).toBe(false);
  });

  it('accepts localhost:<port> as the right value while the reverse is active', async () => {
    const outcome = await runAndroidDoctor(
      ctxWith(doctorRunner({ proxy: 'localhost:8080', reverseList: 'ABCD1234 tcp:8080 tcp:8080\n' })),
    );
    expect(outcome.steps.some((s) => s.status === 'done' && s.message === 'Device proxy is localhost:8080.')).toBe(
      true,
    );
    expect(outcome.steps.some((s) => s.status === 'failed')).toBe(false);
  });

  it('reads the reverse list with Windows line endings and several mappings', async () => {
    const outcome = await runAndroidDoctor(
      ctxWith(
        doctorRunner({
          proxy: 'localhost:8080',
          reverseList: 'ABCD1234 tcp:9000 tcp:9000\r\nABCD1234 tcp:8080 tcp:8080\r\n',
        }),
      ),
    );
    expect(outcome.steps.some((s) => s.status === 'failed')).toBe(false);
  });

  it('does not take a different port for the proxy port', async () => {
    const outcome = await runAndroidDoctor(
      ctxWith(doctorRunner({ proxy: 'localhost:8080', reverseList: 'ABCD1234 tcp:18080 tcp:18080\n' })),
    );
    expect(outcome.steps.some((s) => s.message.includes('no longer forwarding'))).toBe(true);
  });

  it('fails — telling the user to re-run setup — when the proxy says localhost but the reverse has been lost', async () => {
    const outcome = await runAndroidDoctor(ctxWith(doctorRunner({ proxy: 'localhost:8080', reverseList: '' })));
    const failed = outcome.steps.find((s) => s.status === 'failed');
    expect(failed?.message).toContain('no longer forwarding port 8080');
    expect(failed?.message).toContain('detour setup --target android');
  });

  it('still wants the LAN address for a device that is not USB, and rejects localhost there', async () => {
    const runner = fakeRunner((command, args) => {
      if (command === 'adb' && args[0] === 'devices') {
        return { stdout: 'List of devices attached\n192.168.1.20:41234\tdevice\n', stderr: '' };
      }
      if (args.join(' ').includes('settings get global http_proxy')) return { stdout: 'localhost:8080\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps.some((s) => s.message.includes('expected 203.0.113.5:8080'))).toBe(true);
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

  it.each(['localhost', '127.0.0.1', '127.0.1.1', '::1', '0.0.0.0'])(
    'reports failed (never "done") for a loopback --host override (%s), instead of validating the device proxy against an address it could never reach',
    async (loopbackHost) => {
      const runner = fakeRunner((command, args) => {
        if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
        // If the guard didn't fire, this would make the mismatched-loopback
        // check pass as "done" — proving the guard is what's doing the work.
        if (args.includes('get')) return { stdout: `${loopbackHost}:8080\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const outcome = await runAndroidDoctor(ctxWith(runner, { proxyHost: loopbackHost }));
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(loopbackHost) }]);
    },
  );

  it.each(['2001:db8::1', '10.0.0.2:8080'])(
    'reports failed for a --host value containing a colon (%s), never comparing it against the device proxy',
    async (badHost) => {
      const runner = fakeRunner((command, args) => {
        if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
        if (args.includes('get')) return { stdout: `${badHost}:8080\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const outcome = await runAndroidDoctor(ctxWith(runner, { proxyHost: badHost }));
      expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining(badHost) }]);
    },
  );

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

  it("adds a failed step when the device's active network is mobile data — the global proxy setting above only ever applies to Wi-Fi traffic", async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      if (args.includes('dumpsys')) {
        return {
          stdout: 'Active default network: 171\nNetworkAgentInfo{network{171} ... nc{[ Transports: CELLULAR ... ]}\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    const wifiStep = outcome.steps.find((s) => s.status === 'failed' && s.message.includes('mobile data'));
    expect(wifiStep?.message).toContain('configured correctly above');
  });

  it('doesn\'t claim the proxy is "configured correctly above" when that step itself already reported a mismatch — both problems are real, but only one of them is true', async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: 'other-proxy:9999\n', stderr: '' };
      if (args.includes('dumpsys')) {
        return {
          stdout: 'Active default network: 171\nNetworkAgentInfo{network{171} ... nc{[ Transports: CELLULAR ... ]}\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    const wifiStep = outcome.steps.find((s) => s.status === 'failed' && s.message.includes('mobile data'));
    expect(wifiStep?.message).not.toContain('configured correctly above');
    expect(wifiStep?.message).toContain('even once the proxy value above is fixed');
  });

  it('doesn\'t claim a specific proxy mismatch either, when the proxy value itself couldn\'t even be read — a third, distinct outcome from either "matches" or "known mismatch"', async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) throw new CommandRunError('device offline', 'adb');
      if (args.includes('dumpsys')) {
        return {
          stdout: 'Active default network: 171\nNetworkAgentInfo{network{171} ... nc{[ Transports: CELLULAR ... ]}\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    const wifiStep = outcome.steps.find((s) => s.status === 'failed' && s.message.includes('mobile data'));
    expect(wifiStep?.message).not.toContain('configured correctly above');
    expect(wifiStep?.message).not.toContain('even once the proxy value above is fixed');
    expect(wifiStep?.message).toContain("it couldn't be read above");
  });

  it('adds no extra step when Wi-Fi is the active network', async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      if (args.includes('dumpsys')) {
        return {
          stdout: 'Active default network: 301\nNetworkAgentInfo{network{301} ... nc{[ Transports: WIFI ... ]}\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps.filter((s) => s.status === 'failed')).toEqual([]);
  });

  it("adds no extra step when the diagnostic can't tell (dumpsys output doesn't parse) — never a false claim either way", async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      return { stdout: '', stderr: '' }; // dumpsys itself returns nothing usable
    });
    const outcome = await runAndroidDoctor(ctxWith(runner));
    expect(outcome.steps.filter((s) => s.status === 'failed')).toEqual([]);
  });
});

describe('runAndroidCleanup — adb reverse', () => {
  function cleanupRunner(calls: string[][], currentProxy: string, removeThrows = false) {
    return fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') return { stdout: ONE_DEVICE, stderr: '' };
      if (args.join(' ').includes('settings get global http_proxy')) return { stdout: `${currentProxy}\n`, stderr: '' };
      if (removeThrows && args.includes('--remove')) {
        throw new CommandRunError("error: listener 'tcp:8080' not found", 'adb');
      }
      return { stdout: '', stderr: '' };
    });
  }

  it('removes the reverse for a USB device whose proxy is the localhost one setup wrote', async () => {
    const calls: string[][] = [];
    await runAndroidCleanup(ctxWith(cleanupRunner(calls, 'localhost:8080')));
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy :0')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 reverse --remove tcp:8080')).toBe(true);
  });

  it('leaves the reverse alone when setup fell back to the LAN address — it may belong to another tool', async () => {
    const calls: string[][] = [];
    await runAndroidCleanup(ctxWith(cleanupRunner(calls, '203.0.113.5:8080')));
    expect(calls.some((c) => c.includes('--remove'))).toBe(false);
    expect(calls.some((c) => c.join(' ') === 'adb -s ABCD1234 shell settings put global http_proxy :0')).toBe(true);
  });

  it('does not report a failure when the reverse was already gone', async () => {
    const calls: string[][] = [];
    const outcome = await runAndroidCleanup(ctxWith(cleanupRunner(calls, 'localhost:8080', true)));
    expect(outcome.steps.some((s) => s.status === 'failed')).toBe(false);
  });

  it('leaves adb reverse alone for a device reached over Wi-Fi', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (command === 'adb' && args[0] === 'devices') {
        return { stdout: 'List of devices attached\n192.168.1.20:41234\tdevice\n', stderr: '' };
      }
      return { stdout: 'localhost:8080\n', stderr: '' };
    });
    await runAndroidCleanup(ctxWith(runner));
    expect(calls.some((c) => c.includes('reverse'))).toBe(false);
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

describe('classifyDeviceKind', () => {
  it('classifies an `emulator-<port>` serial as an emulator', () => {
    expect(classifyDeviceKind('emulator-5554')).toBe('emulator');
  });

  it('classifies an `<ip>:<port>` serial as Wi-Fi (what `adb connect` was given)', () => {
    expect(classifyDeviceKind('192.168.1.10:5555')).toBe('Wi-Fi (adb over network)');
  });

  it('classifies a hardware serial number as USB', () => {
    expect(classifyDeviceKind('58061FDCH0006M')).toBe('USB');
  });
});

// Fixtures below are trimmed to just what `isWifiActiveNetwork`'s own regex
// actually reads (`Active default network: <id>` plus one matching
// `NetworkAgentInfo{network{<id>}...Transports: <X>`) — real `dumpsys
// connectivity` output is far larger; see this file's own history for a
// firsthand-captured real sample this was verified against.
describe('isWifiActiveNetwork', () => {
  function dumpsysWithActiveTransport(id: number, transport: 'WIFI' | 'CELLULAR'): CommandRunner {
    return fakeRunner(() => ({
      stdout: `Active default network: ${id}\nNetworkAgentInfo{network{${id}} ... nc{[ Transports: ${transport} ... ]}\n`,
      stderr: '',
    }));
  }

  it('returns true when the active network is Wi-Fi', async () => {
    expect(await isWifiActiveNetwork(ctxWith(dumpsysWithActiveTransport(301, 'WIFI')), 'ABCD1234')).toBe(true);
  });

  it('returns false when the active network is cellular', async () => {
    expect(await isWifiActiveNetwork(ctxWith(dumpsysWithActiveTransport(171, 'CELLULAR')), 'ABCD1234')).toBe(false);
  });

  it('returns undefined when there is no active network at all', async () => {
    const runner = fakeRunner(() => ({ stdout: 'Active default network: -1\n', stderr: '' }));
    expect(await isWifiActiveNetwork(ctxWith(runner), 'ABCD1234')).toBeUndefined();
  });

  it("returns undefined rather than guessing when the output doesn't match what this was verified against", async () => {
    const runner = fakeRunner(() => ({ stdout: 'not what dumpsys actually prints', stderr: '' }));
    expect(await isWifiActiveNetwork(ctxWith(runner), 'ABCD1234')).toBeUndefined();
  });

  it('returns undefined (never throws) when the adb command itself fails', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('device offline', 'adb');
      },
    };
    expect(await isWifiActiveNetwork(ctxWith(runner), 'ABCD1234')).toBeUndefined();
  });

  it('returns undefined rather than guessing when the active network is neither Wi-Fi nor cellular (VPN, Ethernet, ...)', async () => {
    const runner = fakeRunner(() => ({
      stdout: 'Active default network: 118\nNetworkAgentInfo{network{118} ... nc{[ Transports: VPN ... ]}\n',
      stderr: '',
    }));
    expect(await isWifiActiveNetwork(ctxWith(runner), 'ABCD1234')).toBeUndefined();
  });

  it('returns false when cellular is present alongside another transport, rather than only ever recognizing an exact "CELLULAR" match', async () => {
    const runner = fakeRunner(() => ({
      stdout: 'Active default network: 42\nNetworkAgentInfo{network{42} ... nc{[ Transports: CELLULAR|VPN ... ]}\n',
      stderr: '',
    }));
    expect(await isWifiActiveNetwork(ctxWith(runner), 'ABCD1234')).toBe(false);
  });
});

describe('requireOneDevice (multi-device picker, exercised via runAndroidDoctor)', () => {
  it("uses the devicePicker's chosen serial when multiple devices are connected", async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: TWO_DEVICES, stderr: '' };
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner, { devicePicker: fakeDevicePicker('EFGH5678') }));
    expect(outcome.steps[1]!.message).toContain('EFGH5678');
  });

  it("falls back to the original fail-outright message when an interactive picker's prompt still comes back empty (e.g. stdin closed mid-prompt)", async () => {
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: TWO_DEVICES, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const outcome = await runAndroidDoctor(ctxWith(runner, { devicePicker: fakeDevicePicker(undefined) }));
    expect(outcome.steps[1]).toEqual({
      status: 'failed',
      message: expect.stringContaining('Multiple devices connected'),
    });
  });

  it("skips building any device's diagnostic (no `dumpsys` calls at all) when the picker reports it can't prompt — nobody will ever see it", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'devices') return { stdout: TWO_DEVICES, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const nonInteractivePicker: DevicePicker = {
      isInteractive: () => false,
      async pick() {
        throw new Error('pick() should never be called when isInteractive() is false');
      },
    };
    await runAndroidDoctor(ctxWith(runner, { devicePicker: nonInteractivePicker }));
    expect(calls.some((c) => c.includes('dumpsys'))).toBe(false);
  });

  it("offers the picker each connected device's classified kind", async () => {
    let offeredChoices: DeviceChoice[] = [];
    const picker: DevicePicker = {
      isInteractive: () => true,
      async pick(choices) {
        offeredChoices = choices;
        return choices[0]?.serial;
      },
    };
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') {
        return { stdout: 'List of devices attached\nABCD1234\tdevice\nemulator-5554\tdevice\n', stderr: '' };
      }
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await runAndroidDoctor(ctxWith(runner, { devicePicker: picker }));
    expect(offeredChoices).toEqual([
      { serial: 'ABCD1234', label: 'ABCD1234 (USB)' },
      { serial: 'emulator-5554', label: 'emulator-5554 (emulator)' },
    ]);
  });

  it("flags whichever choice has mobile data (not Wi-Fi) as its active network, in that choice's label alone", async () => {
    let offeredChoices: DeviceChoice[] = [];
    const picker: DevicePicker = {
      isInteractive: () => true,
      async pick(choices) {
        offeredChoices = choices;
        return choices[0]?.serial;
      },
    };
    const runner = fakeRunner((command, args) => {
      if (args[0] === 'devices') return { stdout: TWO_DEVICES, stderr: '' };
      if (args.includes('dumpsys')) {
        return args[1] === 'ABCD1234'
          ? {
              stdout:
                'Active default network: 171\nNetworkAgentInfo{network{171} ... nc{[ Transports: CELLULAR ... ]}\n',
              stderr: '',
            }
          : {
              stdout: 'Active default network: 301\nNetworkAgentInfo{network{301} ... nc{[ Transports: WIFI ... ]}\n',
              stderr: '',
            };
      }
      if (args.includes('get')) return { stdout: '203.0.113.5:8080\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await runAndroidDoctor(ctxWith(runner, { devicePicker: picker }));
    expect(offeredChoices[0]!.label).toContain('mobile data');
    expect(offeredChoices[1]!.label).not.toContain('mobile data');
  });
});
