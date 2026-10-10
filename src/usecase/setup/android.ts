import type { DeviceChoice } from '../ports/devicePicker';
import { errorMessage } from './errorMessage';
import type { SetupContext, SetupStep, TargetOutcome } from './types';

/**
 * Where the CA cert is pushed on the device — under `Download` so it's
 * reachable from the "Install a certificate" file picker that
 * `runAndroidSetup` opens Security settings to below; in its own `Detour`
 * subfolder rather than `Download` itself, since that file picker lists
 * every other file already in Downloads right alongside it (screenshots,
 * PDFs, app-generated logs, ...) — on a phone with any real usage history
 * that's a wall of unrelated files to hunt `detour-ca.crt` out of, where a
 * lone `Detour` folder is not. `.crt` (not `.pem`) since some Android file
 * pickers filter certificate imports by that extension. No separate `adb
 * shell mkdir -p` for this new subfolder: verified firsthand that `adb
 * push` creates any missing intermediate directories itself, same as `cp
 * --parents` would.
 */
const DEVICE_CERT_DIR = '/sdcard/Download/Detour';
const DEVICE_CERT_PATH = `${DEVICE_CERT_DIR}/detour-ca.crt`;

/** How long the no-`adb` Wi-Fi/QR fallback (see `wifiPairingFallback`) keeps its one-shot HTTP server open waiting for a phone to scan the code and download the cert, before giving up. */
const QR_PAIRING_TIMEOUT_MS = 3 * 60_000;

/** `resolveProxyHost` lets an explicit `--host` override win even for a device target (deliberately, for when auto-detection picks the wrong NIC) — but not every address is usable there. `invalidProxyHostError` checks against every way a hand-typed `--host` can be unusable (see its own doc comment) in every path that either configures or verifies the device's actual proxy value (both `runAndroidSetup`'s adb push and its Wi-Fi/QR fallback, and `runAndroidDoctor`) so a bad `--host` fails loudly instead of silently configuring — or reporting as correct — a proxy value the phone can never actually reach. */
const UNROUTABLE_EXACT_HOSTS = new Set(['localhost', '::1', '0.0.0.0']);

/** Whole `127.0.0.0/8` is loopback, not just `127.0.0.1` — a phone can't reach any address in it any more than the one commonly-typed example. */
function isLoopbackIPv4(host: string): boolean {
  return host.startsWith('127.');
}

/**
 * A `'failed'` step when `ctx.proxyHost` can't work as a device proxy
 * value, `undefined` otherwise:
 *
 * - a loopback address (all of `127.0.0.0/8`, plus `localhost`/`::1`) — a
 *   phone can't reach "this machine" through one, only itself;
 * - `0.0.0.0` — a bind-all address, meaningful as something to *listen*
 *   on, not a destination anything can *connect to*;
 * - anything containing a `:` — a bare IPv6 literal (`fe80::1`) needs
 *   brackets to appear in a URL (`http://[fe80::1]:port/...`) or Android's
 *   `http_proxy` value (`host:port`) at all, and this machine's LAN
 *   detection (`infra/network/lanAddresses.ts`) only ever returns IPv4
 *   addresses anyway, so an unbracketed colon here is either a typo'd
 *   `--host <ip>:<port>` (a host was expected, not a host:port pair) or an
 *   IPv6 address this code doesn't attempt to bracket correctly — either
 *   way, safer to reject it with a clear reason than build a URL/setting
 *   that's silently wrong.
 */
function invalidProxyHostError(ctx: SetupContext): SetupStep | undefined {
  if (UNROUTABLE_EXACT_HOSTS.has(ctx.proxyHost) || isLoopbackIPv4(ctx.proxyHost)) {
    return {
      status: 'failed',
      message: `--host ${ctx.proxyHost} won't work for a device proxy — a phone can't connect to this machine at that address. Pass a real LAN IP with --host, or omit --host to auto-detect one.`,
    };
  }
  if (ctx.proxyHost.includes(':')) {
    return {
      status: 'failed',
      message: `--host ${ctx.proxyHost} isn't a plain IPv4 address or hostname — pass just the address, with no port and no IPv6 colons (e.g. --host 192.168.1.5), or omit --host to auto-detect one.`,
    };
  }
  return undefined;
}

/**
 * Parses `adb devices` output into the serials that are actually usable —
 * drops the "List of devices attached" header and any device reporting
 * `unauthorized` (hasn't accepted this host's RSA key yet) or `offline`.
 */
export function parseAdbDevices(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
    .filter((line) => line.endsWith('\tdevice'))
    .map((line) => line.split('\t')[0]!);
}

/** Thrown by `requireOneDevice` specifically for zero devices — distinguished from "ambiguous, more than one" so `runAndroidSetup` can catch just this case and fall back to Wi-Fi/QR pairing instead of failing outright. */
class NoDeviceError extends Error {}

async function connectedDevices(ctx: SetupContext): Promise<string[]> {
  const { stdout } = await ctx.runner.run('adb', ['devices']);
  return parseAdbDevices(stdout);
}

/**
 * How a serial is classified for a human picking between several — no `adb`
 * call needed, the serial's own shape already says this: `adb`'s emulators
 * are always named `emulator-<port>`, and a Wi-Fi-paired device's serial is
 * always its `<ip>:<port>` (what `adb connect` was given) rather than a
 * hardware serial number.
 */
export function classifyDeviceKind(serial: string): string {
  if (serial.startsWith('emulator-')) return 'emulator';
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)) return 'Wi-Fi (adb over network)';
  return 'USB';
}

/**
 * Worded around `proxyValueMatches` (three-valued, not a plain `boolean` —
 * see `runAndroidDoctor`'s own comment on it) so `runAndroidDoctor`'s
 * mobile-data-active step never claims more than what the proxy-value check
 * right above it actually established: a known-correct value, a
 * known-mismatched one, or one that couldn't even be read.
 */
function mobileDataActiveMessage(proxyValueMatches: boolean | undefined): string {
  if (proxyValueMatches === true) {
    return "This device's active network is mobile data, not Wi-Fi — Android's global proxy setting only applies to Wi-Fi traffic, so it isn't actually being used right now even though it's configured correctly above. Turn off mobile data (or otherwise make Wi-Fi the preferred network) and re-run doctor.";
  }
  if (proxyValueMatches === false) {
    return "This device's active network is mobile data, not Wi-Fi — Android's global proxy setting only applies to Wi-Fi traffic, so even once the proxy value above is fixed, it still won't take effect until Wi-Fi (not mobile data) is this device's active network too.";
  }
  return "This device's active network is mobile data, not Wi-Fi — Android's global proxy setting only applies to Wi-Fi traffic, so it won't take effect until Wi-Fi (not mobile data) is this device's active network too, whatever the proxy value turns out to be (it couldn't be read above). Turn off mobile data (or otherwise make Wi-Fi the preferred network) and re-run doctor.";
}

/**
 * Best-effort: whether `serial`'s currently active default network is
 * Wi-Fi — `runAndroidSetup` writes the proxy to Android's *global*
 * `http_proxy` setting, which only ever applies to Wi-Fi traffic; a device
 * with mobile data as its active network (perfectly possible with both
 * radios on at once — see `describeDeviceChoice`'s doc comment for how this
 * was actually found) silently ignores it, with nothing in the setup/doctor
 * output otherwise pointing at why "the proxy is configured correctly" and
 * "nothing is actually going through it" are both true at once.
 *
 * Parses `dumpsys connectivity`'s own output, which is a debugging dump —
 * not a stable, documented API, and free to reshape itself between Android
 * versions/OEM skins. `undefined` (not `false`) on anything that doesn't
 * match what was verified firsthand on one real device, rather than
 * guessing: a missed parse should stay silent, never assert the opposite of
 * what's actually true. Explicitly: `false` only when `Transports` names
 * `CELLULAR` and not `WIFI` — an earlier version treated *any* non-`WIFI`
 * first token as "mobile data", which would have misreported a VPN or
 * Ethernet connection (an actual possibility here — `Transports` can list
 * more than one, `CELLULAR&VPN` or similar) as mobile data specifically,
 * rather than the "can't tell, so say nothing" this diagnostic is supposed
 * to fall back on for anything that isn't actually Wi-Fi-vs-cellular.
 */
export async function isWifiActiveNetwork(ctx: SetupContext, serial: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await ctx.runner.run('adb', ['-s', serial, 'shell', 'dumpsys', 'connectivity']);
    const activeMatch = stdout.match(/Active default network:\s*(-?\d+)/);
    if (!activeMatch || activeMatch[1] === '-1') return undefined;
    const agentMatch = stdout.match(
      new RegExp(`NetworkAgentInfo\\{network\\{${activeMatch[1]}\\}[\\s\\S]{0,4000}?Transports:\\s*([^\\n]+)`),
    );
    if (!agentMatch) return undefined;
    const transports = agentMatch[1]!;
    if (transports.includes('WIFI')) return true;
    if (transports.includes('CELLULAR')) return false;
    return undefined; // VPN, Ethernet, Bluetooth, ... — not what this diagnostic is about either way
  } catch {
    return undefined;
  }
}

/** One line for `ctx.devicePicker`'s prompt — kind (`classifyDeviceKind`) plus, best-effort, the same Wi-Fi/mobile-data diagnostic `runAndroidDoctor` reports for whichever device ends up chosen (see `isWifiActiveNetwork`'s doc comment for why it matters here specifically: picking *between* devices is exactly when it's cheap to steer towards the one the proxy will actually reach). */
async function describeDeviceChoice(ctx: SetupContext, serial: string): Promise<DeviceChoice> {
  const kind = classifyDeviceKind(serial);
  const wifiActive = await isWifiActiveNetwork(ctx, serial);
  const warning =
    wifiActive === false
      ? " — ⚠ mobile data (not Wi-Fi) is this device's active network right now; the proxy setting won't reach it"
      : '';
  return { serial, label: `${serial} (${kind})${warning}` };
}

async function requireOneDevice(ctx: SetupContext): Promise<string> {
  const devices = await connectedDevices(ctx);
  if (devices.length === 0) {
    throw new NoDeviceError(
      "No authorized device found (`adb devices`) — connect one over USB (or `adb connect <ip>` over Wi-Fi) and accept the host's RSA key fingerprint prompt on the device.",
    );
  }
  if (devices.length === 1) return devices[0]!;

  // Multiple connected devices used to be an unconditional failure ("make
  // the user pick" by disconnecting the rest) — now actually lets them pick,
  // when `ctx.devicePicker` can (an interactive terminal); falls back to the
  // original failure when it can't (CI, a script, anything non-interactive).
  // Checked *before* building each device's `DeviceChoice` (an extra `adb
  // shell dumpsys connectivity` round trip per device — see
  // `describeDeviceChoice`) so a non-interactive run never pays for
  // diagnostics nobody will ever see before hitting the exact same failure
  // either way.
  if (ctx.devicePicker.isInteractive()) {
    const choices = await Promise.all(devices.map((serial) => describeDeviceChoice(ctx, serial)));
    const picked = await ctx.devicePicker.pick(choices);
    if (picked) return picked;
  }
  throw new Error(`Multiple devices connected (${devices.join(', ')}) — disconnect all but one and retry.`);
}

/**
 * No `adb` device at all (no USB connection, no Developer Options/USB
 * debugging enabled) doesn't have to be a dead end: serving the CA cert
 * over a one-shot local HTTP server and printing a QR code for it lets a
 * phone on the same Wi-Fi download (and, on Android, be offered to
 * install) it with nothing more than its camera app — no `adb` required.
 * Gated on `explicitTarget` because it blocks waiting for a scan for up to
 * `QR_PAIRING_TIMEOUT_MS`: fine when the user explicitly asked to set up
 * Android, surprising as a multi-minute hang buried inside a plain `detour
 * setup` sweeping every target.
 */
async function wifiPairingFallback(ctx: SetupContext): Promise<SetupStep[]> {
  if (!ctx.explicitTarget) {
    return [
      {
        status: 'skipped',
        message:
          'No adb device found. Run `detour setup --target android` on its own for a no-adb Wi-Fi pairing option (scan a QR code to download the cert) — skipped here so setting up every target at once never blocks on one waiting for a phone.',
      },
    ];
  }

  try {
    const session = await ctx.certPairingServer.start({
      certPath: ctx.certPath,
      host: ctx.proxyHost,
      timeoutMs: QR_PAIRING_TIMEOUT_MS,
    });
    const waitMinutes = Math.round(QR_PAIRING_TIMEOUT_MS / 60_000);
    const qrStep: SetupStep = {
      status: 'manual',
      message: `No adb device found — scan this QR code with the phone's camera (same Wi-Fi network) to download the CA cert, or open ${session.url} directly. Waiting up to ${waitMinutes} minute(s) (Ctrl+C to stop)...`,
      qrUrl: session.url,
    };
    // The wait below can take up to QR_PAIRING_TIMEOUT_MS — print the QR
    // code *now*, before waiting, or the person meant to scan it would
    // never see it until the whole thing was already over.
    await ctx.onProgress?.(qrStep);
    const steps: SetupStep[] = [qrStep];

    const { downloaded } = await session.waitForDownloadOrTimeout();
    steps.push(
      downloaded
        ? {
            status: 'done',
            message:
              'The cert was downloaded — open it from the notification/Downloads and confirm under Settings → Security → Encryption & credentials → Install a certificate → CA certificate.',
          }
        : {
            status: 'skipped',
            message:
              'Nobody downloaded the cert before the wait timed out — rerun `detour setup --target android` to try again.',
          },
    );
    steps.push({
      status: 'manual',
      message: `Configure the proxy yourself: Settings → Wi-Fi → long-press your network → Modify network → Advanced options → Proxy → Manual, and set Hostname/Port to ${ctx.proxyHost} / ${ctx.proxyPort}.`,
    });
    return steps;
  } catch (err) {
    return [{ status: 'failed', message: `Couldn't serve the CA cert over Wi-Fi: ${errorMessage(err)}` }];
  }
}

/**
 * The message for a failed `adb shell settings put global http_proxy`.
 *
 * `adb shell` normally holds `WRITE_SECURE_SETTINGS`, but some vendor builds
 * withhold it until a developer option is on: "USB debugging (Security
 * settings)" on Xiaomi (MIUI/HyperOS), "Disable permission monitoring" — newer
 * ColorOS calls it "Disable system optimization" — on OPPO, OnePlus and
 * Realme. `adb` then answers with a ~15-line Java stack trace, and the one line
 * that says what to do is buried in it — so that case gets a short, actionable
 * message and the rest of the failures keep the runner's own text.
 */
export function describeProxyWriteFailure(err: unknown): string {
  const message = errorMessage(err);
  if (!message.includes('WRITE_SECURE_SETTINGS')) return `Couldn't set the device's proxy: ${message}`;
  return (
    "Couldn't set the device's proxy: the device refused the write (android.permission.WRITE_SECURE_SETTINGS). " +
    'Some vendor builds need a Developer options switch first: on OPPO / OnePlus / Realme, "Disable permission monitoring" (newer ColorOS: "Disable system optimization"); on Xiaomi, "USB debugging (Security settings)". Turn it on (you may have to confirm a warning), then run this again. ' +
    'If your device has no such option, set the proxy by hand: Settings → Wi-Fi → this network → Proxy → Manual.'
  );
}

export async function runAndroidSetup(ctx: SetupContext): Promise<TargetOutcome> {
  const hostError = invalidProxyHostError(ctx);
  if (hostError) return { steps: [hostError] };

  let serial: string;
  try {
    serial = await requireOneDevice(ctx);
  } catch (err) {
    if (err instanceof NoDeviceError) return { steps: await wifiPairingFallback(ctx) };
    return { steps: [{ status: 'failed', message: errorMessage(err) }] };
  }

  const steps: SetupStep[] = [];

  try {
    await ctx.runner.run('adb', ['-s', serial, 'push', ctx.certPath, DEVICE_CERT_PATH]);
    // `adb push` into a brand-new subfolder can outrun MediaStore's index —
    // the cert file picker below has been seen reporting the `Detour`
    // folder empty for a few seconds after the push with no nudge, then
    // populating instantly once this fires. Genuinely best-effort: wrapped
    // in its own try/catch (unlike the push and `am start` below) so a
    // failure here — the adb invocation itself throwing, not just `am
    // broadcast` reporting no receiver listening, which it treats as
    // success either way — can't turn an otherwise-fine push into a
    // `failed` step. Worst case, the picker needs a few extra seconds to
    // catch up on its own.
    try {
      await ctx.runner.run('adb', [
        '-s',
        serial,
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${DEVICE_CERT_PATH}`,
      ]);
    } catch {
      // Best-effort — see comment above.
    }
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.SECURITY_SETTINGS']);
    steps.push({
      status: 'manual',
      message: `Pushed the CA cert to ${DEVICE_CERT_PATH} and opened Security settings on the device — finish with Encryption & credentials → Install a certificate → CA certificate, picking it from the "Detour" folder under Downloads (Android can't accept a CA cert without that in-device confirmation).`,
    });
  } catch (err) {
    steps.push({
      status: 'failed',
      message: `Couldn't push the CA cert or open Security settings: ${errorMessage(err)}`,
    });
  }

  // A USB device reaches this machine through `adb reverse` (see
  // `enableAdbReverse`), so the proxy value is `localhost:<port>` there; if the
  // reverse cannot be set up it falls back to the LAN address like any other
  // device, and says so.
  const viaAdbReverse = isUsbDevice(serial) && (await enableAdbReverse(ctx, serial));
  if (isUsbDevice(serial) && !viaAdbReverse) {
    steps.push({
      status: 'manual',
      message: `Couldn't set up \`adb reverse\` for this USB device, so its proxy points at this machine's LAN address (${proxyValue(ctx)}) — the device has to be able to reach this machine over the network (a VPN on this machine that blocks local-network traffic would stop that).`,
    });
  }
  const proxy = proxyValue(ctx, viaAdbReverse);
  try {
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', proxy]);
    steps.push({
      status: 'done',
      message: viaAdbReverse
        ? `Set the device's global HTTP proxy to ${proxy}, reaching this machine through \`adb reverse\` over USB (no LAN or VPN in the way).`
        : `Set the device's global HTTP proxy to ${proxy}.`,
    });
  } catch (err) {
    steps.push({ status: 'failed', message: describeProxyWriteFailure(err) });
  }

  return { steps };
}

export async function runAndroidDoctor(ctx: SetupContext): Promise<TargetOutcome> {
  const hostError = invalidProxyHostError(ctx);
  if (hostError) return { steps: [hostError] };

  const steps: SetupStep[] = [];

  try {
    await ctx.runner.run('adb', ['devices']);
    steps.push({ status: 'done', message: '`adb` is installed and reachable.' });
  } catch (err) {
    steps.push({ status: 'failed', message: `\`adb\` isn't usable: ${errorMessage(err)}` });
    return { steps };
  }

  let serial: string | undefined;
  try {
    serial = await requireOneDevice(ctx);
    steps.push({ status: 'done', message: `Device ${serial} is connected and authorized.` });
  } catch (err) {
    steps.push({ status: 'failed', message: errorMessage(err) });
    return { steps };
  }

  // Tracked so the Wi-Fi/mobile-data diagnostic below can word itself
  // correctly either way — that step is added regardless of whether this
  // one actually succeeded, so its own wording can't just assume it did.
  // Three-valued, not just a `boolean`: a caught error below means the
  // proxy value itself was never actually read, distinct from "read
  // successfully and it happened not to match" — collapsing that into
  // `false` would make the diagnostic below claim a specific mismatch
  // ("even once the proxy value above is fixed") when the truth is closer
  // to "couldn't even check that".
  let proxyValueMatches: boolean | undefined;
  try {
    const { stdout } = await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy']);
    const current = stdout.trim();
    // A USB device is set up through `adb reverse` (`localhost:<port>`), so that
    // is a correct value for it too — as long as the reverse is still in place
    // (it does not survive an `adb` server restart or the cable being pulled).
    const reverseValue = proxyValue(ctx, true);
    const usbViaReverse = isUsbDevice(serial) && current === reverseValue;
    proxyValueMatches = current === proxyValue(ctx) || usbViaReverse;
    steps.push(
      proxyValueMatches
        ? { status: 'done', message: `Device proxy is ${current}.` }
        : { status: 'failed', message: `Device proxy is "${current}", expected ${proxyValue(ctx)}.` },
    );
    if (usbViaReverse && (await isAdbReverseActive(ctx, serial)) === false) {
      proxyValueMatches = false;
      steps.push({
        status: 'failed',
        message: `The device's proxy is ${current}, but \`adb reverse\` is no longer forwarding port ${ctx.proxyPort} (it is lost when the \`adb\` server restarts or the cable is unplugged). Re-run \`detour setup --target android\`.`,
      });
    }
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't read the device's proxy: ${errorMessage(err)}` });
  }

  // A correctly-configured proxy value above is necessary but not
  // sufficient — Android's global `http_proxy` only ever applies to Wi-Fi
  // traffic, so it silently does nothing while mobile data is this device's
  // active network (both radios can easily be on at once). `undefined`
  // (couldn't tell) prints nothing rather than a guess either way — see
  // `isWifiActiveNetwork`'s doc comment.
  const wifiActive = await isWifiActiveNetwork(ctx, serial);
  if (wifiActive === false) {
    steps.push({ status: 'failed', message: mobileDataActiveMessage(proxyValueMatches) });
  }

  steps.push({
    status: 'manual',
    message:
      "Cert trust can't be checked over adb without root — verify under Settings → Security → Encryption & credentials → Trusted credentials → User.",
  });

  return { steps };
}

export async function runAndroidCleanup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];
  let serial: string | undefined;
  try {
    serial = await requireOneDevice(ctx);
  } catch (err) {
    steps.push({ status: 'failed', message: errorMessage(err) });
    return { steps };
  }

  try {
    // ":0" is the documented reset value for this global setting — `settings
    // delete` isn't reliable across Android versions the way this is.
    // Read before clearing: a proxy of `localhost:<port>` is what `setup` writes
    // when it set up `adb reverse` for this device, so only then is that reverse
    // ours to remove. If setup fell back to the LAN address (the port was already
    // forwarded by something else, say), tearing it down would break that tool.
    const ownedReverse = isUsbDevice(serial) && (await currentDeviceProxy(ctx, serial)) === proxyValue(ctx, true);
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
    steps.push({ status: 'done', message: "Cleared the device's global HTTP proxy." });
    if (ownedReverse) {
      try {
        await ctx.runner.run('adb', ['-s', serial, 'reverse', '--remove', `tcp:${ctx.proxyPort}`]);
      } catch {
        // Already gone (cable pulled, `adb` restarted) — not worth a failed step.
      }
    }
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't clear the device's proxy: ${errorMessage(err)}` });
  }

  steps.push({
    status: 'manual',
    message:
      'Left the CA cert installed — remove it yourself under Settings → Security → Encryption & credentials → Trusted credentials → User if you want it gone.',
  });

  return { steps };
}

/**
 * The `host:port` this device's proxy setting should hold — `localhost` for a USB
 * device that reaches this machine through `adb reverse`, this machine's LAN
 * address otherwise. (`localhost`, not `127.0.0.1`: it is the usual form for an
 * `adb reverse` proxy, and the value that was confirmed working by hand on a real
 * USB device.)
 */
function proxyValue(ctx: SetupContext, viaAdbReverse = false): string {
  return `${viaAdbReverse ? 'localhost' : ctx.proxyHost}:${ctx.proxyPort}`;
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
function isUsbDevice(serial: string): boolean {
  return classifyDeviceKind(serial) === 'USB' && !serial.startsWith('adb-');
}

/**
 * Makes this machine's proxy port reachable at the device's own
 * `localhost:<port>` through the `adb` connection (`adb reverse`), so a USB
 * device does not have to reach this machine over the LAN at all.
 *
 * Why that matters: the LAN address is what a Wi-Fi device needs, but for a USB
 * device it is a needless dependency — and one that breaks as soon as
 * something between the phone and this machine's LAN interface does, e.g. a
 * VPN on this machine that blocks local-network traffic (the phone then reaches
 * nothing, with no error anywhere). `adb`'s own connection is initiated from
 * this machine and travels over USB, so neither is affected.
 *
 * `true` once the reverse is in place; `false` when `adb reverse` failed (old
 * `adb`/device, a vendor build refusing it, or the port already being forwarded
 * by something else), so the caller falls back to the LAN address instead of
 * leaving the device pointing at a `localhost` that goes nowhere.
 */
async function enableAdbReverse(ctx: SetupContext, serial: string): Promise<boolean> {
  const port = `tcp:${ctx.proxyPort}`;
  try {
    // `--no-rebind`: fail rather than silently take over a reverse another tool
    // already holds on this port (and that `cleanup` would then tear down).
    await ctx.runner.run('adb', ['-s', serial, 'reverse', '--no-rebind', port, port]);
    return true;
  } catch {
    return false;
  }
}

/** The device's current global proxy value, or `undefined` if it could not be read. */
async function currentDeviceProxy(ctx: SetupContext, serial: string): Promise<string | undefined> {
  try {
    const { stdout } = await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Whether `adb reverse` currently forwards this machine's proxy port for `serial` (`adb reverse --list` prints `<serial> tcp:<port> tcp:<port>` per mapping). */
async function isAdbReverseActive(ctx: SetupContext, serial: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await ctx.runner.run('adb', ['-s', serial, 'reverse', '--list']);
    const port = `tcp:${ctx.proxyPort}`;
    return stdout.split('\n').some((line) => {
      const [, remote, local] = line.trim().split(/\s+/);
      return remote === port && local === port;
    });
  } catch {
    return undefined;
  }
}
