import { errorMessage } from './errorMessage';
import type { SetupContext, SetupStep, TargetOutcome } from './types';

/** Where the CA cert is pushed on the device — `Download` so it's easy for the user to find from the "Install a certificate" file picker that `runAndroidSetup` opens Security settings to below; `.crt` (not `.pem`) since some Android file pickers filter certificate imports by that extension. */
const DEVICE_CERT_PATH = '/sdcard/Download/detour-ca.crt';

/** How long the no-`adb` Wi-Fi/QR fallback (see `wifiPairingFallback`) keeps its one-shot HTTP server open waiting for a phone to scan the code and download the cert, before giving up. */
const QR_PAIRING_TIMEOUT_MS = 3 * 60_000;

/** `resolveProxyHost` lets an explicit `--host` override win even for a device target (deliberately, for when auto-detection picks the wrong NIC) — but a loopback address is never valid there: a phone can't resolve "this machine" through it, only itself. `wifiPairingFallback` checks against this before ever starting `certPairingServer` (see that port's own doc comment on the same rule) so a mistaken `--host localhost` fails loudly instead of encoding a QR code that can never work. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

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

async function requireOneDevice(ctx: SetupContext): Promise<string> {
  const devices = await connectedDevices(ctx);
  if (devices.length === 0) {
    throw new NoDeviceError(
      "No authorized device found (`adb devices`) — connect one over USB (or `adb connect <ip>` over Wi-Fi) and accept the host's RSA key fingerprint prompt on the device.",
    );
  }
  // Multiple connected devices is ambiguous (which one gets the proxy/cert?)
  // — same "make the user pick" stance as `adb`'s own `-s <serial>` requirement.
  if (devices.length > 1) {
    throw new Error(`Multiple devices connected (${devices.join(', ')}) — disconnect all but one and retry.`);
  }
  return devices[0]!;
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

  if (LOOPBACK_HOSTS.has(ctx.proxyHost)) {
    return [
      {
        status: 'failed',
        message: `--host ${ctx.proxyHost} won't work for Wi-Fi pairing — a phone can't reach this machine at a loopback address to download the cert. Pass a real LAN IP with --host, or omit --host to auto-detect one.`,
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

export async function runAndroidSetup(ctx: SetupContext): Promise<TargetOutcome> {
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
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.SECURITY_SETTINGS']);
    steps.push({
      status: 'manual',
      message: `Pushed the CA cert to ${DEVICE_CERT_PATH} and opened Security settings on the device — finish with Encryption & credentials → Install a certificate → CA certificate (Android can't accept a CA cert without that in-device confirmation).`,
    });
  } catch (err) {
    steps.push({
      status: 'failed',
      message: `Couldn't push the CA cert or open Security settings: ${errorMessage(err)}`,
    });
  }

  try {
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', proxyValue(ctx)]);
    steps.push({ status: 'done', message: `Set the device's global HTTP proxy to ${proxyValue(ctx)}.` });
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't set the device's proxy: ${errorMessage(err)}` });
  }

  return { steps };
}

export async function runAndroidDoctor(ctx: SetupContext): Promise<TargetOutcome> {
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

  try {
    const { stdout } = await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy']);
    const current = stdout.trim();
    steps.push(
      current === proxyValue(ctx)
        ? { status: 'done', message: `Device proxy is ${current}.` }
        : { status: 'failed', message: `Device proxy is "${current}", expected ${proxyValue(ctx)}.` },
    );
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't read the device's proxy: ${errorMessage(err)}` });
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
    await ctx.runner.run('adb', ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
    steps.push({ status: 'done', message: "Cleared the device's global HTTP proxy." });
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

function proxyValue(ctx: SetupContext): string {
  return `${ctx.proxyHost}:${ctx.proxyPort}`;
}
