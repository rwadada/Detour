import path from 'node:path';
import type { Command } from 'commander';
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
}

/**
 * `detour record` (issue #149): runs `command` with `HTTP_PROXY`/
 * `HTTPS_PROXY` pointed at a fresh, single-run proxy instance — the same
 * mechanism as `detour test` — and writes one fixture file per captured
 * exchange to `--out`, for `detour serve` to replay later without a proxy
 * at all. A passthrough exchange (Intercept off, or a host outside Focus)
 * has nothing decrypted to replay and is skipped, as is one that never got
 * a response at all (errored before headers arrived).
 */
export async function runRecordCommand(command: string[], options: RecordOptions): Promise<void> {
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
    .argument('<command...>', 'Command to run under the proxy, e.g. `detour record -- npm run e2e`')
    .option(
      '--out <dir>',
      `Directory to write fixture files to (default: ${DEFAULT_FIXTURES_DIR})`,
      DEFAULT_FIXTURES_DIR,
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
