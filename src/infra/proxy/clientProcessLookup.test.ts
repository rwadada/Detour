import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../usecase/ports/commandRunner';
import { lookupClientProcess, parseLsofFieldOutput } from './clientProcessLookup';

function fakeRunner(handler: (command: string, args: string[]) => CommandResult): CommandRunner {
  return { run: async (command, args) => handler(command, args) };
}

function throwingRunner(err: unknown): CommandRunner {
  return {
    run: async () => {
      throw err;
    },
  };
}

describe('parseLsofFieldOutput', () => {
  it("parses a process's established TCP connections from lsof -F pcn output", () => {
    const output = [
      'p1234',
      'cGoogle Chrome Helper',
      'f45',
      'n127.0.0.1:54321->127.0.0.1:8080',
      'p5678',
      'cnode',
      'f12',
      // 203.0.113.0/24 (RFC 5737 TEST-NET-3) — reserved for documentation,
      // never a real routable address, so no hardcoded-IP lint concerns.
      'n203.0.113.5:33333->93.184.216.34:443',
    ].join('\n');

    expect(parseLsofFieldOutput(output)).toEqual([
      { pid: 1234, command: 'Google Chrome Helper', localAddress: '127.0.0.1', localPort: 54321 },
      { pid: 5678, command: 'node', localAddress: '203.0.113.5', localPort: 33333 },
    ]);
  });

  it('captures more than one connection under the same process', () => {
    const output = ['p1', 'cSafari', 'f10', 'n127.0.0.1:1->127.0.0.1:8080', 'f11', 'n127.0.0.1:2->127.0.0.1:8080'].join(
      '\n',
    );

    expect(parseLsofFieldOutput(output)).toEqual([
      { pid: 1, command: 'Safari', localAddress: '127.0.0.1', localPort: 1 },
      { pid: 1, command: 'Safari', localAddress: '127.0.0.1', localPort: 2 },
    ]);
  });

  it('skips a name with no local:port->remote:port shape (e.g. a listening socket)', () => {
    const output = ['p1', 'cnode', 'f3', 'n*:8080'].join('\n');
    expect(parseLsofFieldOutput(output)).toEqual([]);
  });

  it('ignores an n line with no preceding p/c pair', () => {
    expect(parseLsofFieldOutput('n127.0.0.1:1->127.0.0.1:8080')).toEqual([]);
  });

  it('returns an empty array for empty output', () => {
    expect(parseLsofFieldOutput('')).toEqual([]);
  });
});

describe('lookupClientProcess', () => {
  it('finds the process whose local address:port matches the given client endpoint', async () => {
    const runner = fakeRunner((command, args) => {
      expect(command).toBe('lsof');
      expect(args).toEqual(['-n', '-P', '-iTCP', '-sTCP:ESTABLISHED', '-F', 'pcn']);
      return {
        stdout: ['p777', 'cSafari', 'f4', 'n127.0.0.1:54321->127.0.0.1:8080'].join('\n'),
        stderr: '',
      };
    });

    await expect(lookupClientProcess(runner, '127.0.0.1', 54321)).resolves.toEqual({ pid: 777, name: 'Safari' });
  });

  it('resolves undefined when no connection matches the given endpoint', async () => {
    const runner = fakeRunner(() => ({
      stdout: ['p777', 'cSafari', 'f4', 'n127.0.0.1:1->127.0.0.1:8080'].join('\n'),
      stderr: '',
    }));

    await expect(lookupClientProcess(runner, '127.0.0.1', 54321)).resolves.toBeUndefined();
  });

  it('resolves undefined (rather than rejecting) when lsof is missing or fails', async () => {
    await expect(lookupClientProcess(throwingRunner(new Error('ENOENT')), '127.0.0.1', 1)).resolves.toBeUndefined();
  });
});
