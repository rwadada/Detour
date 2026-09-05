import { CommandRunError } from '../ports/commandRunner';
import type { SetupContext, SetupStep, TargetOutcome } from './types';

const GSETTINGS_MISSING_MESSAGE =
  "`gsettings` isn't available (not a GNOME desktop, or headless) — set the proxy through your desktop's network settings, or export http_proxy/https_proxy for the shells you use.";

export async function runLinuxSetup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];

  try {
    await setGnomeProxy(ctx);
    steps.push({
      status: 'done',
      message: `Set GNOME's proxy (org.gnome.system.proxy) to manual, ${ctx.proxyHost}:${ctx.proxyPort}.`,
    });
  } catch (err) {
    steps.push({ status: err instanceof CommandRunError ? 'skipped' : 'failed', message: gsettingsErrorMessage(err) });
  }

  steps.push({
    status: 'manual',
    message: `Trust the CA cert yourself (requires sudo): sudo cp ${ctx.certPath} /usr/local/share/ca-certificates/detour-ca.crt && sudo update-ca-certificates`,
  });

  return { steps };
}

export async function runLinuxDoctor(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];

  try {
    const mode = (await ctx.runner.run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).stdout.trim();
    const host = (await ctx.runner.run('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'])).stdout
      .trim()
      .replace(/^'|'$/g, '');
    const port = (await ctx.runner.run('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'])).stdout.trim();
    const matches = mode === "'manual'" && host === ctx.proxyHost && port === String(ctx.proxyPort);
    steps.push(
      matches
        ? { status: 'done', message: `GNOME's proxy is ${host}:${port}.` }
        : {
            status: 'failed',
            message: `GNOME's proxy is mode=${mode} ${host}:${port}, expected manual ${ctx.proxyHost}:${ctx.proxyPort}.`,
          },
    );
  } catch (err) {
    steps.push({ status: err instanceof CommandRunError ? 'skipped' : 'failed', message: gsettingsErrorMessage(err) });
  }

  steps.push({
    status: 'manual',
    message:
      "Cert trust can't be checked automatically — compare `openssl x509 -noout -fingerprint -in <cert>` against your system trust store.",
  });

  return { steps };
}

export async function runLinuxCleanup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];
  try {
    await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
    steps.push({ status: 'done', message: "Set GNOME's proxy mode back to none." });
  } catch (err) {
    steps.push({ status: err instanceof CommandRunError ? 'skipped' : 'failed', message: gsettingsErrorMessage(err) });
  }
  return { steps };
}

async function setGnomeProxy(ctx: SetupContext): Promise<void> {
  await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual']);
  await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', ctx.proxyHost]);
  await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', String(ctx.proxyPort)]);
  await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', ctx.proxyHost]);
  await ctx.runner.run('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', String(ctx.proxyPort)]);
}

function gsettingsErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes('not found') ? `${GSETTINGS_MISSING_MESSAGE} (${raw})` : raw;
}
