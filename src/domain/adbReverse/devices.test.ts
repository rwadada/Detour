import { describe, expect, it } from 'vitest';
import { isUsbDevice, parseAdbDevices, splitTrackDevicesFrames, usbDevicesIn } from './devices';

/** One `track-devices` frame: 4 hex digits of length (in bytes), then that many bytes. */
function frame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  return Buffer.concat([Buffer.from(bytes.length.toString(16).padStart(4, '0')), bytes]);
}

describe('isUsbDevice', () => {
  it('accepts a hardware serial', () => {
    expect(isUsbDevice('RFCW10F9EEX')).toBe(true);
    expect(isUsbDevice('35121FDJH000R8')).toBe(true);
  });

  it('rejects emulators, network serials and wireless-debugging (mDNS) names', () => {
    expect(isUsbDevice('emulator-5554')).toBe(false);
    expect(isUsbDevice('192.168.1.20:41234')).toBe(false);
    expect(isUsbDevice('adb-35121FDJH000R8-xyMD0H._adb-tls-connect._tcp')).toBe(false);
    expect(isUsbDevice('adb-35121FDJH000R8-xyMD0H')).toBe(false);
  });
});

describe('parseAdbDevices', () => {
  it('keeps only ready devices, skipping the header, unauthorized and offline ones', () => {
    const out = 'List of devices attached\nAAA\tdevice\nBBB\tunauthorized\nCCC\toffline\nDDD\tdevice\n';
    expect(parseAdbDevices(out)).toEqual(['AAA', 'DDD']);
  });

  it('reads the lines of a track-devices list (no header)', () => {
    expect(parseAdbDevices('AAA\tdevice\nBBB\tdevice\n')).toEqual(['AAA', 'BBB']);
  });
});

describe('splitTrackDevicesFrames', () => {
  it('reads the empty list adb sends when nothing is connected ("0000")', () => {
    const { lists, rest } = splitTrackDevicesFrames(Buffer.from('0000'));
    expect(lists).toEqual(['']);
    expect(rest).toHaveLength(0);
  });

  it('reads one list', () => {
    const { lists, rest } = splitTrackDevicesFrames(frame('AAA\tdevice\n'));
    expect(lists).toEqual(['AAA\tdevice\n']);
    expect(rest).toHaveLength(0);
  });

  it('reads several lists that arrived in one chunk, in order', () => {
    const chunk = Buffer.concat([frame('AAA\tdevice\n'), frame(''), frame('BBB\tdevice\n')]);
    expect(splitTrackDevicesFrames(chunk).lists).toEqual(['AAA\tdevice\n', '', 'BBB\tdevice\n']);
  });

  it('keeps an incomplete frame as the rest, and completes it with the next chunk', () => {
    const whole = frame('AAA\tdevice\n');
    const first = splitTrackDevicesFrames(whole.subarray(0, 7));
    expect(first.lists).toEqual([]);
    expect(first.rest.equals(whole.subarray(0, 7))).toBe(true);
    const second = splitTrackDevicesFrames(Buffer.concat([first.rest, whole.subarray(7)]));
    expect(second.lists).toEqual(['AAA\tdevice\n']);
    expect(second.rest).toHaveLength(0);
  });

  it('keeps a header that has not fully arrived', () => {
    const { lists, rest } = splitTrackDevicesFrames(Buffer.from('00'));
    expect(lists).toEqual([]);
    expect(rest.toString()).toBe('00');
  });

  it('drops a buffer whose length prefix is not hex instead of waiting on it forever', () => {
    expect(splitTrackDevicesFrames(Buffer.from('FAIL')).rest).toHaveLength(0);
    expect(splitTrackDevicesFrames(Buffer.from('xyz!and more')).lists).toEqual([]);
  });

  it('counts the length in bytes, so a list holding a multi-byte character does not put the next frame out of step', () => {
    // "é" is 2 bytes in UTF-8: counted in characters the next frame would start one byte too early.
    const chunk = Buffer.concat([frame('Pixel é\tdevice\n'), frame('BBB\tdevice\n')]);
    expect(splitTrackDevicesFrames(chunk).lists).toEqual(['Pixel é\tdevice\n', 'BBB\tdevice\n']);
  });
});

describe('usbDevicesIn', () => {
  it('lists only the ready USB devices of one list', () => {
    const list =
      'RFCW10F9EEX\tdevice\n192.168.1.20:41234\tdevice\nemulator-5554\tdevice\nadb-35121FDJH000R8-xyMD0H\tdevice\nUNAUTH\tunauthorized\n';
    expect(usbDevicesIn(list)).toEqual(['RFCW10F9EEX']);
  });
});
