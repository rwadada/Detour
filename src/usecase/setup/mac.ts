import os from 'node:os';
import path from 'node:path';
import type { SetupContext, SetupStep, TargetOutcome } from './types';

/** `security add-trusted-cert` targets the current user's login keychain (not the System keychain, which needs `-d` and a sudo prompt) — trusting the cert for this user only, with no password prompt beyond an already-unlocked login keychain. */
function loginKeychainPath(): string {
  return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

/**
 * Parses `networksetup -listallnetworkservices` output into just the
 * enabled service names — the first line is a disclaimer ("An asterisk (*)
 * denotes...") and a disabled service is prefixed with `*`, neither of
 * which is a real service name.
 */
export function parseEnabledNetworkServices(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*') && !line.toLowerCase().startsWith('an asterisk'));
}

/** Picks which network service to point at the proxy: "Wi-Fi" if it's enabled (the common case), else the first enabled service. */
export function pickNetworkService(enabledServices: string[]): string | undefined {
  return enabledServices.includes('Wi-Fi') ? 'Wi-Fi' : enabledServices[0];
}

async function activeNetworkService(ctx: SetupContext): Promise<string> {
  const { stdout } = await ctx.runner.run('networksetup', ['-listallnetworkservices']);
  const service = pickNetworkService(parseEnabledNetworkServices(stdout));
  if (!service) {
    throw new Error(
      'No enabled network service found (`networksetup -listallnetworkservices`) to configure a proxy on.',
    );
  }
  return service;
}

export async function runMacSetup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];

  try {
    await ctx.runner.run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', loginKeychainPath(), ctx.certPath]);
    steps.push({ status: 'done', message: `Trusted ${ctx.certPath} in the login keychain.` });
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't trust the CA cert: ${errorMessage(err)}` });
  }

  try {
    const service = await activeNetworkService(ctx);
    await ctx.runner.run('networksetup', ['-setwebproxy', service, ctx.proxyHost, String(ctx.proxyPort)]);
    await ctx.runner.run('networksetup', ['-setsecurewebproxy', service, ctx.proxyHost, String(ctx.proxyPort)]);
    steps.push({
      status: 'done',
      message: `Set the "${service}" network service's HTTP/HTTPS proxy to ${ctx.proxyHost}:${ctx.proxyPort}.`,
    });
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't configure the system proxy: ${errorMessage(err)}` });
  }

  return { steps };
}

export async function runMacDoctor(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];

  try {
    await ctx.runner.run('security', ['verify-cert', '-c', ctx.certPath]);
    steps.push({ status: 'done', message: 'CA cert is trusted (security verify-cert).' });
  } catch (err) {
    steps.push({ status: 'failed', message: `CA cert is not trusted yet: ${errorMessage(err)}` });
  }

  try {
    const service = await activeNetworkService(ctx);
    const { stdout } = await ctx.runner.run('networksetup', ['-getwebproxy', service]);
    const state = parseGetWebProxy(stdout);
    const matches = state.enabled && state.server === ctx.proxyHost && state.port === String(ctx.proxyPort);
    const currentDescription = state.enabled ? `${state.server}:${state.port}` : 'disabled';
    steps.push(
      matches
        ? { status: 'done', message: `"${service}" is proxied through ${ctx.proxyHost}:${ctx.proxyPort}.` }
        : {
            status: 'failed',
            message: `"${service}"'s web proxy is ${currentDescription}, expected ${ctx.proxyHost}:${ctx.proxyPort}.`,
          },
    );
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't check the system proxy: ${errorMessage(err)}` });
  }

  return { steps };
}

export async function runMacCleanup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];
  try {
    const service = await activeNetworkService(ctx);
    await ctx.runner.run('networksetup', ['-setwebproxystate', service, 'off']);
    await ctx.runner.run('networksetup', ['-setsecurewebproxystate', service, 'off']);
    steps.push({ status: 'done', message: `Turned off "${service}"'s HTTP/HTTPS proxy.` });
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't turn off the system proxy: ${errorMessage(err)}` });
  }
  steps.push({
    status: 'manual',
    message: `Left the CA cert's trust setting as-is (run \`security delete-certificate -c "<cert common name>"\` yourself if you want it untrusted again).`,
  });
  return { steps };
}

/** Parses `networksetup -getwebproxy <service>`'s `Key: Value` lines into the fields these usecases care about. */
export function parseGetWebProxy(stdout: string): { enabled: boolean; server?: string; port?: string } {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [key, ...rest] = line.split(':');
    if (rest.length === 0) continue;
    fields.set(key!.trim(), rest.join(':').trim());
  }
  return { enabled: fields.get('Enabled') === 'Yes', server: fields.get('Server'), port: fields.get('Port') };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
