import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { CommandRunError } from '../ports/commandRunner';
import { parseAdbDevices, runAndroidCleanup, runAndroidDoctor, runAndroidSetup } from './android';
import type { SetupContext } from './types';

const ONE_DEVICE = 'List of devices attached\nABCD1234\tdevice\n';
const NONE_AUTHORIZED = 'List of devices attached\nABCD1234\tunauthorized\n';
const TWO_DEVICES = 'List of devices attached\nABCD1234\tdevice\nEFGH5678\tdevice\n';

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

function ctxWith(runner: CommandRunner): SetupContext {
  return { certPath: '/ca.pem', proxyHost: '203.0.113.5', proxyPort: 8080, runner, hostPlatform: 'darwin' };
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

  it('fails cleanly with no device connected', async () => {
    const runner = fakeRunner(() => ({ stdout: 'List of devices attached\n', stderr: '' }));
    const outcome = await runAndroidSetup(ctxWith(runner));
    expect(outcome.steps).toEqual([{ status: 'failed', message: expect.stringContaining('No authorized device') }]);
  });

  it('fails cleanly with adb missing entirely', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"adb" not found — is it installed and on PATH?', 'adb');
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
        throw new CommandRunError('"adb" not found — is it installed and on PATH?', 'adb');
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
