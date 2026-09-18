import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../../usecase/ports/commandRunner';
import { ClientProcessDirectory, parseLsofFieldOutput } from './clientProcessLookup';

function fakeRunner(handler: (command: string, args: string[]) => CommandResult): CommandRunner {
  return { run: async (command, args) => handler(command, args) };
}

/** Flushes pending microtasks (a `refresh()` call's own `await`s) without depending on fake-timer-controlled macrotasks — `vi.useFakeTimers()` only fakes `setTimeout`/`setInterval`, not native Promise resolution. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
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

describe('ClientProcessDirectory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has nothing to find before the first refresh completes', () => {
    const directory = new ClientProcessDirectory(
      fakeRunner(() => ({
        stdout: ['p777', 'cSafari', 'f4', 'n127.0.0.1:54321->127.0.0.1:8080'].join('\n'),
        stderr: '',
      })),
    );
    expect(directory.lookup('127.0.0.1', 54321)).toBeUndefined();
  });

  it('finds the process whose local address:port matches after start() runs its first refresh', async () => {
    const directory = new ClientProcessDirectory(
      fakeRunner((command, args) => {
        expect(command).toBe('lsof');
        expect(args).toEqual(['-n', '-P', '-iTCP', '-sTCP:ESTABLISHED', '-F', 'pcn']);
        return { stdout: ['p777', 'cSafari', 'f4', 'n127.0.0.1:54321->127.0.0.1:8080'].join('\n'), stderr: '' };
      }),
    );

    directory.start();
    await flushMicrotasks();

    expect(directory.lookup('127.0.0.1', 54321)).toEqual({ pid: 777, name: 'Safari' });
    directory.stop();
  });

  it('refreshes again on the next interval tick, picking up a since-closed/opened connection', async () => {
    let stdout = ['p1', 'cFirst', 'f1', 'n127.0.0.1:1->127.0.0.1:8080'].join('\n');
    const directory = new ClientProcessDirectory(fakeRunner(() => ({ stdout, stderr: '' })));

    directory.start();
    await flushMicrotasks();
    expect(directory.lookup('127.0.0.1', 1)).toEqual({ pid: 1, name: 'First' });

    stdout = ['p2', 'cSecond', 'f1', 'n127.0.0.1:2->127.0.0.1:8080'].join('\n');
    await vi.advanceTimersByTimeAsync(2000);

    expect(directory.lookup('127.0.0.1', 1)).toBeUndefined();
    expect(directory.lookup('127.0.0.1', 2)).toEqual({ pid: 2, name: 'Second' });

    directory.stop();
  });

  it('stop() halts further refreshes', async () => {
    let calls = 0;
    const directory = new ClientProcessDirectory(
      fakeRunner(() => {
        calls++;
        return { stdout: '', stderr: '' };
      }),
    );

    directory.start();
    await flushMicrotasks();
    expect(calls).toBe(1);

    directory.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });

  it('keeps the previous snapshot (rather than clearing it) when a refresh throws', async () => {
    let shouldFail = false;
    const directory = new ClientProcessDirectory(
      fakeRunner(() => {
        if (shouldFail) throw new Error('ENOENT');
        return { stdout: ['p1', 'cSafari', 'f1', 'n127.0.0.1:1->127.0.0.1:8080'].join('\n'), stderr: '' };
      }),
    );
    directory.start();
    await flushMicrotasks();
    expect(directory.lookup('127.0.0.1', 1)).toEqual({ pid: 1, name: 'Safari' });

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(2000);

    expect(directory.lookup('127.0.0.1', 1)).toEqual({ pid: 1, name: 'Safari' });
    directory.stop();
  });

  it('resolves undefined when no connection matches the given endpoint', async () => {
    const directory = new ClientProcessDirectory(
      fakeRunner(() => ({ stdout: ['p777', 'cSafari', 'f4', 'n127.0.0.1:1->127.0.0.1:8080'].join('\n'), stderr: '' })),
    );
    directory.start();
    await flushMicrotasks();

    expect(directory.lookup('127.0.0.1', 54321)).toBeUndefined();
    directory.stop();
  });
});
