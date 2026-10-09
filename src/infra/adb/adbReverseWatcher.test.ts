import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../usecase/ports/commandRunner';
import { CommandRunError } from '../../usecase/ports/commandRunner';
import { startAdbReverseWatcher, type StreamingProcess } from './adbReverseWatcher';

/** `adb track-devices` frame: 4 hex digits of length, then the list. */
function frame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  return Buffer.concat([Buffer.from(bytes.length.toString(16).padStart(4, '0')), bytes]);
}

/** A fake `adb track-devices` the test drives by hand. */
function fakeAdb() {
  const processes: Array<{
    args: string[];
    emit: (chunk: Buffer) => void;
    end: () => void;
    killed: boolean;
    process: StreamingProcess;
  }> = [];
  const spawn = (_command: string, args: string[]): StreamingProcess => {
    let dataListener: (chunk: Buffer) => void = () => {};
    let exitListener: () => void = () => {};
    const entry = {
      args,
      emit: (chunk: Buffer) => dataListener(chunk),
      end: () => exitListener(),
      killed: false,
      process: undefined as unknown as StreamingProcess,
    };
    entry.process = {
      onData: (listener) => (dataListener = listener),
      onExit: (listener) => (exitListener = listener),
      kill: () => {
        entry.killed = true;
      },
    };
    processes.push(entry);
    return entry.process;
  };
  return { spawn, processes };
}

function recordingRunner(failFor: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      if (failFor(args)) throw new CommandRunError('adb: error: cannot rebind existing socket', command);
      return { stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

const reverseCalls = (calls: string[][]) => calls.filter((c) => c.includes('reverse')).map((c) => c.join(' '));

describe('startAdbReverseWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows adb track-devices', () => {
    const adb = fakeAdb();
    startAdbReverseWatcher({ port: 8080, runner: recordingRunner().runner, spawn: adb.spawn });
    expect(adb.processes).toHaveLength(1);
    expect(adb.processes[0]!.args).toEqual(['track-devices']);
  });

  it('puts the reverse on a USB device as soon as it shows up', async () => {
    const adb = fakeAdb();
    const { runner, calls } = recordingRunner();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn });

    adb.processes[0]!.emit(frame(''));
    expect(reverseCalls(calls)).toEqual([]);

    adb.processes[0]!.emit(frame('RFCW10F9EEX\tdevice\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reverseCalls(calls)).toEqual(['adb -s RFCW10F9EEX reverse --no-rebind tcp:8080 tcp:8080']);
  });

  it('puts it back when the cable is pulled and plugged in again', async () => {
    const adb = fakeAdb();
    const { runner, calls } = recordingRunner();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn });
    const send = (body: string) => adb.processes[0]!.emit(frame(body));

    send('RFCW10F9EEX\tdevice\n');
    await vi.advanceTimersByTimeAsync(0);
    send(''); // unplugged
    await vi.advanceTimersByTimeAsync(0);
    send('RFCW10F9EEX\tdevice\n'); // plugged in again
    await vi.advanceTimersByTimeAsync(0);

    expect(reverseCalls(calls)).toHaveLength(2);
  });

  it('only logs "restored" once per reconnect, though every list re-applies', async () => {
    const adb = fakeAdb();
    const log = vi.fn();
    startAdbReverseWatcher({ port: 8080, runner: recordingRunner().runner, spawn: adb.spawn, log });
    const send = (body: string) => adb.processes[0]!.emit(frame(body));

    send('AAA\tdevice\n');
    await vi.advanceTimersByTimeAsync(0);
    send('AAA\tdevice\nBBB\tunauthorized\n'); // another device changed state
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(1);

    send(''); // gone
    send('AAA\tdevice\n'); // back
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('leaves everything that is not a ready USB device alone', async () => {
    const adb = fakeAdb();
    const { runner, calls } = recordingRunner();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn });

    adb.processes[0]!.emit(
      frame(
        'emulator-5554\tdevice\n192.168.1.20:41234\tdevice\nadb-35121FDJH000R8-xyMD0H\tdevice\nAAA\tunauthorized\nBBB\toffline\n',
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reverseCalls(calls)).toEqual([]);
  });

  it('copes with frames split across reads and several in one', async () => {
    const adb = fakeAdb();
    const { runner, calls } = recordingRunner();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn });
    const whole = Buffer.concat([frame('AAA\tdevice\n'), frame('AAA\tdevice\nBBB\tdevice\n')]);

    adb.processes[0]!.emit(whole.subarray(0, 9));
    adb.processes[0]!.emit(whole.subarray(9));
    await vi.advanceTimersByTimeAsync(0);

    expect(reverseCalls(calls)).toContain('adb -s BBB reverse --no-rebind tcp:8080 tcp:8080');
    expect(reverseCalls(calls)).toContain('adb -s AAA reverse --no-rebind tcp:8080 tcp:8080');
  });

  it('is not bothered by adb reverse failing (already there, or held by another tool)', async () => {
    const adb = fakeAdb();
    const { runner } = recordingRunner(() => true);
    const log = vi.fn();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn, log });

    adb.processes[0]!.emit(frame('AAA\tdevice\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(log).not.toHaveBeenCalled(); // not "restored" when nothing was restored
  });

  it('starts adb track-devices again after it ended, until stopped', async () => {
    const adb = fakeAdb();
    startAdbReverseWatcher({ port: 8080, runner: recordingRunner().runner, spawn: adb.spawn, restartDelayMs: 1000 });

    adb.processes[0]!.end(); // adb server restarted, or adb not installed
    expect(adb.processes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adb.processes).toHaveLength(2);

    adb.processes[1]!.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(adb.processes).toHaveLength(3);
  });

  it('reapplies after a restart: the list that follows is applied to the devices in it', async () => {
    const adb = fakeAdb();
    const { runner, calls } = recordingRunner();
    startAdbReverseWatcher({ port: 8080, runner, spawn: adb.spawn, restartDelayMs: 1000 });

    adb.processes[0]!.end();
    await vi.advanceTimersByTimeAsync(1000);
    adb.processes[1]!.emit(frame('RFCW10F9EEX\tdevice\n'));
    await vi.advanceTimersByTimeAsync(0);

    expect(reverseCalls(calls)).toEqual(['adb -s RFCW10F9EEX reverse --no-rebind tcp:8080 tcp:8080']);
  });

  it('stop() kills adb track-devices and does not start it again', async () => {
    const adb = fakeAdb();
    const watcher = startAdbReverseWatcher({
      port: 8080,
      runner: recordingRunner().runner,
      spawn: adb.spawn,
      restartDelayMs: 1000,
    });
    expect(watcher.isRunning()).toBe(true);

    watcher.stop();
    expect(adb.processes[0]!.killed).toBe(true);
    expect(watcher.isRunning()).toBe(false);

    adb.processes[0]!.end(); // the kill makes it exit
    await vi.advanceTimersByTimeAsync(5000);
    expect(adb.processes).toHaveLength(1);
  });

  it('stop() also cancels a restart that was already scheduled', async () => {
    const adb = fakeAdb();
    const watcher = startAdbReverseWatcher({
      port: 8080,
      runner: recordingRunner().runner,
      spawn: adb.spawn,
      restartDelayMs: 1000,
    });
    adb.processes[0]!.end();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(adb.processes).toHaveLength(1);
  });

  it('counts the USB devices connected right now', async () => {
    const adb = fakeAdb();
    const watcher = startAdbReverseWatcher({ port: 8080, runner: recordingRunner().runner, spawn: adb.spawn });
    expect(watcher.connectedUsbDevices()).toBe(0);

    adb.processes[0]!.emit(frame('AAA\tdevice\nBBB\tdevice\nemulator-5554\tdevice\n'));
    expect(watcher.connectedUsbDevices()).toBe(2);
    adb.processes[0]!.emit(frame(''));
    expect(watcher.connectedUsbDevices()).toBe(0);
  });
});
