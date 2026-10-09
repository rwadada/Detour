/**
 * Which `adb` devices Detour can reach through `adb reverse`, and how to read
 * what `adb` says about them. Pure — the process that runs `adb` lives in
 * `infra/adb`.
 */

/** How a serial is told apart: `adb`'s emulators are `emulator-<port>`, a device `adb connect`ed over the network is `<ip>:<port>`, and anything else is a hardware serial. */
export function classifyDeviceKind(serial: string): string {
  if (serial.startsWith('emulator-')) return 'emulator';
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) return 'Wi-Fi (adb over network)';
  return 'USB';
}

/**
 * A device that is certainly USB-attached — the only kind `adb reverse` is
 * relied on for. `classifyDeviceKind` already rules out emulators and
 * `<ip>:<port>` network serials, but calls everything else "USB", and that
 * includes the name `adb` gives a device found through Android 11+ wireless
 * debugging (mDNS): `adb-<hardware serial>-<random>` (the instance name in
 * Google's own `adb mdns` examples). Treating that as USB would swap a working
 * LAN proxy for a `localhost` one that reaches nothing without a reverse — so
 * anything that looks like it falls back to the LAN address instead.
 */
export function isUsbDevice(serial: string): boolean {
  return classifyDeviceKind(serial) === 'USB' && !serial.startsWith('adb-');
}

/**
 * Parses `adb devices` output into the serials that are actually usable —
 * drops the "List of devices attached" header and any device reporting
 * `unauthorized` (hasn't accepted this host's RSA key yet) or `offline`.
 *
 * The same `<serial>\t<state>` lines are what `adb track-devices` sends (after a
 * length prefix, see `splitTrackDevicesFrames`).
 */
export function parseAdbDevices(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
    .filter((line) => line.endsWith('\tdevice'))
    .map((line) => line.split('\t')[0]!);
}

/**
 * Splits the byte stream of `adb track-devices` into device lists. Each list is
 * a 4-digit hex length followed by that many **bytes** (Google's adb
 * `services.md`: "a new device list description is sent each time a device is
 * added/removed or the state of a given device changes"); a list can arrive
 * split across reads, and several can arrive in one.
 *
 * Works on bytes, not characters: the length counts bytes, so a list holding
 * a non-ASCII byte would put every later frame out of step if it were counted
 * in characters.
 *
 * Returns the complete lists found in `buffer` and whatever is left over (an
 * incomplete frame, to be prepended to the next chunk). A length that is not
 * hex means the stream is not what this expects: nothing is returned and the
 * buffer is dropped, so the caller does not wait forever on a garbage prefix.
 */
export function splitTrackDevicesFrames(buffer: Buffer): { lists: string[]; rest: Buffer } {
  const lists: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const header = buffer.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { lists, rest: Buffer.alloc(0) };
    const length = Number.parseInt(header, 16);
    if (buffer.length - offset < 4 + length) break;
    lists.push(buffer.toString('utf8', offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { lists, rest: buffer.subarray(offset) };
}

/** The USB devices in one `track-devices` list that are ready for `adb` commands. */
export function usbDevicesIn(list: string): string[] {
  return parseAdbDevices(list).filter(isUsbDevice);
}
