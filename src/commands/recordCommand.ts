import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parseHarLog } from '../domain/exchange/harImport';
import { buildFixtureFromExchange } from '../domain/record/buildFixture';
import { writeFixtureFile } from '../infra/fs/fixtureFileSource';
import { runCommandUnderProxy } from '../infra/process/commandUnderProxy';
import { startProxyServer } from '../infra/proxy/proxyServer';
import { createEventBusWithErrorLogging, loadOptionalRuleEngine } from './oneShotProxyRun';
import { describeError, parsePort } from './optionParsers';

export const DEFAULT_FIXTURES_DIR = './fixtures';

export interface RecordOptions {
  out: string;
  rules?: string;
  allowExternalScriptPaths?: boolean;
  port: string;
  /** `--from-har <path>` (issue #167): converts an existing HAR 1.2 file into fixtures instead of recording live traffic — see `runRecordFromHar`. */
  fromHar?: string;
}

/**
 * `detour record --from-har <path>` (issue #167): converts a HAR 1.2 file
 * — someone else's tool's recording, or Detour's own dashboard export —
 * straight into fixtures, with no live proxy run at all. Reuses
 * `buildFixtureFromExchange`, the exact same conversion a live `detour
 * record` run's `response` listener already calls, so a HAR-derived
 * fixture behaves identically to one recorded live. An entry with no
 * response `status` (shouldn't happen for a spec-conformant HAR, but
 * `parseHarLog` doesn't itself require a *meaningful* one) is skipped,
 * matching the live path's "no response at all" skip.
 */
function runRecordFromHar(harPath: string, out: string): void {
  const outDir = path.resolve(out);
  const resolvedHarPath = path.resolve(harPath);
  let text: string;
  try {
    text = fs.readFileSync(resolvedHarPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read HAR file: ${resolvedHarPath}\n  ${describeError(err)}`, { cause: err });
  }
  const exchanges = parseHarLog(text);

  let sequence = 0;
  let recordedCount = 0;
  for (const exchange of exchanges) {
    if (exchange.statusCode === undefined) continue;
    sequence += 1;
    const { fixture, filename } = buildFixtureFromExchange(exchange, sequence);
    writeFixtureFile(outDir, filename, fixture);
    recordedCount += 1;
  }
  console.log(`✔ Converted ${recordedCount} HAR entr${recordedCount === 1 ? 'y' : 'ies'} to fixtures in ${outDir}`);
}

/**
 * `detour record` (issue #149): runs `command` with `HTTP_PROXY`/
 * `HTTPS_PROXY` pointed at a fresh, single-run proxy instance — the same
 * mechanism as `detour test` — and writes one fixture file per captured
 * exchange to `--out`, for `detour serve` to replay later without a proxy
 * at all. A passthrough exchange (Intercept off, or a host outside Focus)
 * has nothing decrypted to replay and is skipped, as is one that never got
 * a response at all (errored before headers arrived).
 *
 * `--from-har <path>` (issue #167) takes over entirely instead — see
 * `runRecordFromHar` — and is mutually exclusive with a `command`.
 */
export async function runRecordCommand(command: string[], options: RecordOptions): Promise<void> {
  if (options.fromHar) {
    if (command.length > 0) {
      throw new Error('detour record --from-har converts a HAR file directly and takes no command to run');
    }
    // Neither flag does anything on this path — no proxy runs, so no rule
    // ever gets a chance to apply. Rejecting outright (agy code review)
    // rather than silently ignoring them: without this, a `--from-har`
    // invocation that also passed `--rules` would look like it mocked/
    // rewrote the imported traffic when it never touched it at all.
    if (options.rules !== undefined) {
      throw new Error(
        'detour record --from-har converts a HAR file directly — --rules has no effect and is not allowed here',
      );
    }
    if (options.allowExternalScriptPaths) {
      throw new Error(
        'detour record --from-har converts a HAR file directly — --allow-external-script-paths has no effect and is not allowed here',
      );
    }
    return runRecordFromHar(options.fromHar, options.out);
  }
  if (command.length === 0) {
    throw new Error(
      'detour record requires a command to run traffic through the proxy, e.g. `detour record -- npm run e2e`',
    );
  }

  const outDir = path.resolve(options.out);
  const port = parsePort(options.port, '--port');
  const ruleEngine = loadOptionalRuleEngine(options.rules, options.allowExternalScriptPaths ?? false);
  const eventBus = createEventBusWithErrorLogging();
  let sequence = 0;
  let recordedCount = 0;
  eventBus.on('response', (exchange) => {
    if (exchange.passthrough || exchange.statusCode === undefined) return;
    sequence += 1;
    const { fixture, filename } = buildFixtureFromExchange(exchange, sequence);
    // A write failure here (disk full, permission denied, an invalid
    // --out path) must not throw out of this listener — it runs
    // synchronously inside the proxy's own 'response' emit, so an uncaught
    // exception would crash the whole recording run instead of just
    // failing to persist this one exchange.
    try {
      writeFixtureFile(outDir, filename, fixture);
      recordedCount += 1;
    } catch (err) {
      eventBus.emit('error', { errorKind: 'FIXTURE_WRITE_ERROR', message: describeError(err) });
    }
  });

  const handle = await startProxyServer({ port, ruleEngine }, eventBus);
  const proxyUrl = `http://localhost:${handle.port}`;
  console.log(`ℹ Proxy listening on ${proxyUrl} — recording to ${outDir} — running: ${command.join(' ')}`);

  try {
    const childExitCode = await runCommandUnderProxy(command, proxyUrl, handle.caCertPath);
    console.log(`✔ Recorded ${recordedCount} exchange(s) to ${outDir}`);
    if (childExitCode !== 0) {
      console.error(`✖ Command exited with code ${childExitCode}`);
      process.exitCode = childExitCode;
    }
  } finally {
    await handle.stop();
  }
}

/** Wires `detour record` into the CLI. */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description(
      `Runs a command with HTTP_PROXY/HTTPS_PROXY pointed at a fresh proxy instance and records every captured exchange as a fixture file, for \`detour serve\` to replay later without a proxy at all (issue #149)`,
    )
    // Optional (not `<command...>`): `--from-har` replaces the command
    // entirely (see `runRecordCommand`'s doc comment) — `[]` when omitted,
    // which `runRecordCommand` itself then requires one or the other of.
    .argument('[command...]', 'Command to run under the proxy, e.g. `detour record -- npm run e2e`')
    .option(
      '--out <dir>',
      `Directory to write fixture files to (default: ${DEFAULT_FIXTURES_DIR})`,
      DEFAULT_FIXTURES_DIR,
    )
    .option(
      '--from-har <path>',
      'Converts a HAR 1.2 file (issue #167) directly into fixtures instead of recording live traffic — no command, proxy, or --rules involved. Mutually exclusive with a command.',
    )
    .option(
      '--rules <path>',
      'Path to a rules file to apply while recording (e.g. to mock a flaky third-party dependency) — same format as `detour start --rules`, loaded once and not watched for changes.',
    )
    .option(
      '--allow-external-script-paths',
      "Allow a rule's `script.path`/`mock.bodyFile` to resolve outside the directory rules.json lives in (including an absolute path) instead of being rejected — see `detour start`'s flag of the same name.",
    )
    .option('-p, --port <port>', 'Port the proxy listens on (default: an ephemeral free port)', '0')
    .action(async (command: string[], options: RecordOptions) => {
      try {
        await runRecordCommand(command, options);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
