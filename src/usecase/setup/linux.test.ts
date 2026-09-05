import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { CommandRunError } from '../ports/commandRunner';
import { runLinuxCleanup, runLinuxDoctor, runLinuxSetup } from './linux';
import type { SetupContext } from './types';

function fakeRunner(handler: (command: string, args: string[]) => CommandResult): CommandRunner {
  return {
    async run(command, args) {
      return handler(command, args);
    },
  };
}

function ctxWith(runner: CommandRunner): SetupContext {
  return { certPath: '/ca.pem', proxyHost: '127.0.0.1', proxyPort: 8080, runner, hostPlatform: 'linux' };
}

describe('runLinuxSetup', () => {
  it('sets gsettings proxy and notes the manual cert-trust step', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    });
    const outcome = await runLinuxSetup(ctxWith(runner));
    expect(outcome.steps.map((s) => s.status)).toEqual(['done', 'manual']);
    expect(calls.some((c) => c.join(' ') === 'gsettings set org.gnome.system.proxy mode manual')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'gsettings set org.gnome.system.proxy.http host 127.0.0.1')).toBe(true);
  });

  it('reports skipped (not failed) when gsettings is missing', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"gsettings" not found — is it installed and on PATH?', 'gsettings');
      },
    };
    const outcome = await runLinuxSetup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('skipped');
    expect(outcome.steps[0]!.message).toContain("isn't available");
  });
});

describe('runLinuxDoctor', () => {
  it('reports done when the proxy matches', async () => {
    const runner = fakeRunner((_command, args) => {
      if (args[1] === 'org.gnome.system.proxy') return { stdout: "'manual'\n", stderr: '' };
      if (args[2] === 'host') return { stdout: "'127.0.0.1'\n", stderr: '' };
      return { stdout: '8080\n', stderr: '' };
    });
    const outcome = await runLinuxDoctor(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('done');
  });

  it('reports failed when the proxy mode/host/port do not match', async () => {
    const runner = fakeRunner(() => ({ stdout: "'none'\n", stderr: '' }));
    const outcome = await runLinuxDoctor(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('failed');
  });

  it('reports skipped when gsettings is missing', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"gsettings" not found — is it installed and on PATH?', 'gsettings');
      },
    };
    const outcome = await runLinuxDoctor(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('skipped');
  });
});

describe('runLinuxCleanup', () => {
  it('sets proxy mode to none', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    });
    const outcome = await runLinuxCleanup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('done');
    expect(calls[0]).toEqual(['gsettings', 'set', 'org.gnome.system.proxy', 'mode', 'none']);
  });

  it('reports skipped when gsettings is missing', async () => {
    const runner: CommandRunner = {
      async run() {
        throw new CommandRunError('"gsettings" not found — is it installed and on PATH?', 'gsettings');
      },
    };
    const outcome = await runLinuxCleanup(ctxWith(runner));
    expect(outcome.steps[0]!.status).toBe('skipped');
  });
});
