import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { parseSimulators, runIosCleanup, runIosDoctor, runIosSetup } from './ios';
import type { SetupContext } from './types';

const BOOTED_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      { udid: 'AAAA-1111', name: 'iPhone 17 Pro', state: 'Booted' },
      { udid: 'BBBB-2222', name: 'iPad Air', state: 'Shutdown' },
    ],
  },
});

const NONE_BOOTED_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'BBBB-2222', name: 'iPad Air', state: 'Shutdown' }],
  },
});

describe('parseSimulators', () => {
  it('flattens every runtime into one list', () => {
    expect(parseSimulators(BOOTED_LIST)).toHaveLength(2);
  });

  it('returns no devices for unparseable output instead of throwing', () => {
    expect(parseSimulators('not json')).toEqual([]);
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

describe('runIosSetup', () => {
  it('trusts the cert on every booted Simulator and still lists physical-device manual steps', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      if (args.includes('booted')) return { stdout: BOOTED_LIST, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const outcome = await runIosSetup(ctxWith(runner));

    expect(outcome.steps[0]).toEqual({ status: 'done', message: expect.stringContaining('iPhone 17 Pro') });
    expect(outcome.steps.some((s) => s.status === 'manual')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'xcrun simctl keychain AAAA-1111 add-root-cert /ca.pem')).toBe(true);
  });

  it('skips Simulator automation and still lists manual steps when none is booted', async () => {
    const runner = fakeRunner(() => ({ stdout: NONE_BOOTED_LIST, stderr: '' }));
    const outcome = await runIosSetup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('skipped');
    expect(outcome.steps.some((s) => s.status === 'manual')).toBe(true);
  });

  it('reports a failed step (not a throw) when xcrun itself is unusable', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error('"xcrun" not found');
      },
    };
    const outcome = await runIosSetup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('failed');
    expect(outcome.steps.some((s) => s.status === 'manual')).toBe(true);
  });
});

describe('runIosDoctor', () => {
  it('reports done when a Simulator is booted', async () => {
    const runner = fakeRunner(() => ({ stdout: BOOTED_LIST, stderr: '' }));
    const outcome = await runIosDoctor(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('done');
  });

  it('reports skipped when none is booted', async () => {
    const runner = fakeRunner(() => ({ stdout: NONE_BOOTED_LIST, stderr: '' }));
    const outcome = await runIosDoctor(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('skipped');
  });
});

describe('runIosCleanup', () => {
  it('never touches the Simulator keychain — only manual physical-device steps', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    });
    const outcome = await runIosCleanup(ctxWith(runner));
    expect(calls).toEqual([]);
    expect(outcome.steps.every((s) => s.status === 'manual')).toBe(true);
  });
});
