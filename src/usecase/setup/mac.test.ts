import { describe, expect, it } from 'vitest';
import type { CertPairingServer } from '../ports/certPairingServer';
import type { CommandResult, CommandRunner } from '../ports/commandRunner';
import { CommandRunError } from '../ports/commandRunner';
import {
  parseEnabledNetworkServices,
  parseGetWebProxy,
  pickNetworkService,
  runMacCleanup,
  runMacDoctor,
  runMacSetup,
} from './mac';
import type { SetupContext } from './types';

/** mac.ts never touches the pairing server (that's android.ts's no-adb fallback only) — a throwing stub makes any accidental use loud. */
const unusedCertPairingServer: CertPairingServer = {
  async start() {
    throw new Error('certPairingServer.start() should not be called here');
  },
};

const LIST_SERVICES =
  'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\nThunderbolt Bridge\n*iPhone USB\n';

describe('parseEnabledNetworkServices', () => {
  it('drops the disclaimer line and disabled (*) services', () => {
    expect(parseEnabledNetworkServices(LIST_SERVICES)).toEqual(['Wi-Fi', 'Thunderbolt Bridge']);
  });
});

describe('pickNetworkService', () => {
  it('prefers Wi-Fi when enabled', () => {
    expect(pickNetworkService(['Ethernet', 'Wi-Fi'])).toBe('Wi-Fi');
  });

  it('falls back to the first enabled service otherwise', () => {
    expect(pickNetworkService(['Ethernet', 'Thunderbolt Bridge'])).toBe('Ethernet');
  });

  it('returns undefined when nothing is enabled', () => {
    expect(pickNetworkService([])).toBeUndefined();
  });
});

describe('parseGetWebProxy', () => {
  it('parses an enabled proxy', () => {
    expect(parseGetWebProxy('Enabled: Yes\nServer: 203.0.113.5\nPort: 8080\n')).toEqual({
      enabled: true,
      server: '203.0.113.5',
      port: '8080',
    });
  });

  it('parses a disabled proxy', () => {
    expect(parseGetWebProxy('Enabled: No\nServer: \nPort: 0\n').enabled).toBe(false);
  });
});

function fakeRunner(handlers: Record<string, (args: string[]) => CommandResult>): CommandRunner {
  return {
    async run(command, args) {
      const handler = handlers[command];
      if (!handler) throw new CommandRunError(`unexpected command: ${command}`, command);
      return handler(args);
    },
  };
}

function ctxWith(runner: CommandRunner): SetupContext {
  return {
    certPath: '/ca.pem',
    proxyHost: '127.0.0.1',
    proxyPort: 8080,
    runner,
    certPairingServer: unusedCertPairingServer,
    hostPlatform: 'darwin',
    explicitTarget: false,
  };
}

describe('runMacSetup', () => {
  it('trusts the cert and configures the active service proxy', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner({
      security: (args) => {
        calls.push(['security', ...args]);
        return { stdout: '', stderr: '' };
      },
      networksetup: (args) => {
        calls.push(['networksetup', ...args]);
        if (args[0] === '-listallnetworkservices') return { stdout: LIST_SERVICES, stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });

    const outcome = await runMacSetup(ctxWith(runner));

    expect(outcome.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(calls.some((c) => c[0] === 'security' && c[1] === 'add-trusted-cert')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'networksetup -setwebproxy Wi-Fi 127.0.0.1 8080')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8080')).toBe(true);
  });

  it('reports a failed step instead of throwing when a command fails', async () => {
    const runner = fakeRunner({
      security: () => {
        throw new CommandRunError('boom', 'security');
      },
      networksetup: (args) =>
        args[0] === '-listallnetworkservices' ? { stdout: LIST_SERVICES, stderr: '' } : { stdout: '', stderr: '' },
    });

    const outcome = await runMacSetup(ctxWith(runner));
    expect(outcome.steps[0]).toEqual({ status: 'failed', message: expect.stringContaining('boom') });
  });
});

describe('runMacDoctor', () => {
  it('reports done when trusted and proxy matches', async () => {
    const runner = fakeRunner({
      security: () => ({ stdout: '', stderr: '' }),
      networksetup: (args) =>
        args[0] === '-listallnetworkservices'
          ? { stdout: LIST_SERVICES, stderr: '' }
          : { stdout: 'Enabled: Yes\nServer: 127.0.0.1\nPort: 8080\n', stderr: '' },
    });
    const outcome = await runMacDoctor(ctxWith(runner));
    expect(outcome.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('reports failed when the proxy points elsewhere', async () => {
    const runner = fakeRunner({
      security: () => ({ stdout: '', stderr: '' }),
      networksetup: (args) =>
        args[0] === '-listallnetworkservices'
          ? { stdout: LIST_SERVICES, stderr: '' }
          : { stdout: 'Enabled: No\nServer: \nPort: \n', stderr: '' },
    });
    const outcome = await runMacDoctor(ctxWith(runner));
    expect(outcome.steps[1]!.status).toBe('failed');
  });
});

describe('runMacCleanup', () => {
  it('turns the proxy off and leaves cert trust as a manual note', async () => {
    const runner = fakeRunner({
      networksetup: (args) =>
        args[0] === '-listallnetworkservices' ? { stdout: LIST_SERVICES, stderr: '' } : { stdout: '', stderr: '' },
    });
    const outcome = await runMacCleanup(ctxWith(runner));
    expect(outcome.steps.map((s) => s.status)).toEqual(['done', 'manual']);
  });
});
