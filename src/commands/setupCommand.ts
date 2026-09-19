import fs from 'node:fs';
import type { Command } from 'commander';
import { SETUP_TARGETS } from '../domain/setup/targets';
import { lanAddresses } from '../infra/network/lanAddresses';
import { nodeCommandRunner } from '../infra/process/nodeCommandRunner';
import { readlineDevicePicker } from '../infra/process/readlineDevicePicker';
import { caCertPath, ensureCaCert } from '../infra/proxy/certExport';
import { nodeCertPairingServer } from '../infra/proxy/nodeCertPairingServer';
import { hasFailedStep, printStep, printTargetReports } from '../presentation/setupReport';
import { runTargets } from '../usecase/setup/orchestrator';
import type { SetupMode } from '../usecase/setup/orchestrator';
import { parsePort, parseSetupTarget } from './optionParsers';

export interface SetupCommandOptions {
  target?: string;
  port: string;
  host?: string;
}

/**
 * Shared body for `detour setup`/`doctor`/`cleanup` (issue #65) — the three
 * commands differ only in which `SetupMode` they run and whether they issue
 * the CA cert (`setup`) or merely look for one already issued
 * (`doctor`/`cleanup`, which must never have the side effect of generating
 * one just by asking a readiness question).
 */
export async function runSetupCommand(mode: SetupMode, options: SetupCommandOptions): Promise<void> {
  try {
    const target = parseSetupTarget(options.target);
    const port = parsePort(options.port, '--port');

    let certPath: string;
    let certMissing = false;
    if (mode === 'setup') {
      certPath = await ensureCaCert();
      console.log(`✔ CA certificate ready at ${certPath}`);
    } else {
      certPath = caCertPath();
      certMissing = !fs.existsSync(certPath);
      if (certMissing) {
        // `doctor` reports readiness and exits non-zero on anything off —
        // no cert generated at all means nothing downstream (trust,
        // proxy) can possibly be configured yet, even for a target whose
        // own doctor check doesn't verify cert trust directly (e.g.
        // linux's, which just notes it can't check that automatically),
        // so this has to fail loudly rather than the informational-only
        // note it used to be. `cleanup` doesn't carry the same "report
        // readiness" promise — its job is reverting proxy config
        // regardless of cert state — so it keeps the plain ℹ note.
        console.log(
          mode === 'doctor'
            ? `✖ No CA certificate generated yet (run \`detour setup\` first) — it would live at ${certPath}.`
            : `ℹ No CA certificate generated yet (run \`detour setup\` first) — it would live at ${certPath}.`,
        );
      }
    }

    const reports = await runTargets(mode, target ? [target] : undefined, {
      hostOverride: options.host,
      certPath,
      proxyPort: port,
      runner: nodeCommandRunner,
      certPairingServer: nodeCertPairingServer,
      devicePicker: readlineDevicePicker,
      hostPlatform: process.platform,
      detectedLanAddresses: lanAddresses(),
      explicitTarget: target !== undefined,
      onProgress: printStep,
    });
    await printTargetReports(mode, reports);
    if (hasFailedStep(reports) || (mode === 'doctor' && certMissing)) process.exitCode = 1;
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** Wires `detour setup`/`doctor`/`cleanup` into the CLI — one shared set of options, three modes. */
export function registerSetupCommands(program: Command): void {
  const setupTargetOption = [
    '--target <target>',
    `Limit to one target: ${SETUP_TARGETS.join(', ')} (default: every target).`,
  ] as const;
  const setupPortOption = [
    '-p, --port <port>',
    "Proxy port to advise/configure the target to use (matches the --port you'll pass to `detour start`).",
    '8080',
  ] as const;
  const setupHostOption = [
    '--host <host>',
    "Override the address advertised to the target (default: localhost for a target that is this machine, this machine's auto-detected LAN IP for a separate device like Android).",
  ] as const;

  program
    .command('setup')
    .description(
      'Prepares a target device/OS to send traffic through detour (issue #65): issues the local CA cert (first run) and, for android/mac/linux, trusts it and configures the proxy automatically (android with --target and no adb device falls back to a QR-code Wi-Fi pairing flow for the cert); ios trusts it on a booted Simulator (xcrun simctl) but still prints manual steps for a physical device — windows is manual-only.',
    )
    .option(...setupTargetOption)
    .option(...setupPortOption)
    .option(...setupHostOption)
    .action(async (options: SetupCommandOptions) => {
      await runSetupCommand('setup', options);
    });

  program
    .command('doctor')
    .description(
      "Checks whether a target is ready for (or already has) detour's proxy/cert set up (issue #65) — never generates a CA cert itself, unlike `detour setup`.",
    )
    .option(...setupTargetOption)
    .option(...setupPortOption)
    .option(...setupHostOption)
    .action(async (options: SetupCommandOptions) => {
      await runSetupCommand('doctor', options);
    });

  program
    .command('cleanup')
    .description(
      "Clears the proxy configuration `detour setup` applied to a target (issue #65) — never touches rules.json, `detour config`, or the target's CA cert trust.",
    )
    .option(...setupTargetOption)
    .option(...setupPortOption)
    .option(...setupHostOption)
    .action(async (options: SetupCommandOptions) => {
      await runSetupCommand('cleanup', options);
    });
}
