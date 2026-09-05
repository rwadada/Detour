import type { SetupContext, SetupStep, TargetOutcome } from './types';

/** Where the CA cert is pushed on the device — `Download` so it's easy for the user to find from the "Install a certificate" file picker that `runAndroidSetup` opens Security settings to below; `.crt` (not `.pem`) since some Android file pickers filter certificate imports by that extension. */
const DEVICE_CERT_PATH = '/sdcard/Download/detour-ca.crt';

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

async function requireOneDevice(ctx: SetupContext): Promise<string> {
  const { stdout } = await ctx.runner.run('adb', ['devices']);
  const devices = parseAdbDevices(stdout);
  if (devices.length === 0) {
    throw new Error(
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

export async function runAndroidSetup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];

  let serial: string | undefined;
  try {
    serial = await requireOneDevice(ctx);
  } catch (err) {
    steps.push({ status: 'failed', message: errorMessage(err) });
    return { steps };
  }

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
