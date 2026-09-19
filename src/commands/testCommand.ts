import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { CapturedExchange } from '../domain/exchange/types';
import { evaluateAssertions } from '../domain/test/evaluate';
import { formatTestReport } from '../domain/test/report';
import { loadTestFile } from '../infra/fs/testFileSource';
import { runCommandUnderProxy } from '../infra/process/commandUnderProxy';
import { startProxyServer } from '../infra/proxy/proxyServer';
import { createEventBusWithErrorLogging, loadOptionalRuleEngine } from './oneShotProxyRun';
import { parsePort } from './optionParsers';

/** Default value of `--assertions` (issue #148) — unlike `--rules`'s auto-detection (which silently no-ops if `DEFAULT_RULES_FILENAME` isn't present), this filename is always the effective default, and `runTestCommand` fails fast if it doesn't exist. */
export const DEFAULT_TEST_ASSERTIONS_FILENAME = 'detour.test.json';

/** Caps `runTestCommand`'s in-memory exchange array — see its `eventBus.on('response', ...)` listener's doc comment. */
export const MAX_CAPTURED_TEST_EXCHANGES = 10_000;

export interface TestOptions {
  assertions: string;
  rules?: string;
  allowExternalScriptPaths?: boolean;
  port: string;
}

/**
 * `detour test` (issue #148): runs `command` with `HTTP_PROXY`/`HTTPS_PROXY`
 * pointed at a fresh, single-run proxy instance, then evaluates every
 * exchange captured during that run against a `detour test` assertions
 * file (header presence, PII leaks, p95 latency — see domain/test/types.ts)
 * — a communication contract test suitable for CI, built on the same
 * proxy core as `detour start` rather than a separate implementation.
 * Deliberately no `--headless`/`--exit-on-idle`/dashboard/run-state
 * tracking here: `command`'s own exit is what ends the run, and this is a
 * one-shot CI step rather than a long-lived instance meant to be managed
 * with `detour status`/`stop`.
 */
export async function runTestCommand(command: string[], options: TestOptions): Promise<void> {
  if (command.length === 0) {
    throw new Error(
      'detour test requires a command to run traffic through the proxy, e.g. `detour test -- npm run e2e`',
    );
  }

  const assertionsPath = path.resolve(options.assertions);
  if (!fs.existsSync(assertionsPath)) {
    throw new Error(
      `Test assertions file not found: ${assertionsPath}\n` +
        `Pass --assertions <path>, or create ${DEFAULT_TEST_ASSERTIONS_FILENAME} in the current directory. Example:\n` +
        `{\n  "assertions": [\n    { "type": "headerPresent", "name": "orders API requires auth", "match": { "url": "https://api.example.com/orders*" }, "header": "Authorization" }\n  ]\n}`,
    );
  }
  // Loaded eagerly — same reasoning as `--rules`/`.proto` in runStartBody —
  // so a broken assertions file fails before the command under test ever
  // runs, rather than after paying for a full (possibly slow) test run.
  const testFile = loadTestFile(assertionsPath);

  const port = parsePort(options.port, '--port');
  const ruleEngine = loadOptionalRuleEngine(options.rules, options.allowExternalScriptPaths ?? false);
  const eventBus = createEventBusWithErrorLogging();
  const exchanges: CapturedExchange[] = [];
  let exchangeCapWarned = false;
  eventBus.on('response', (exchange) => {
    // Bounds memory use against a command under test that generates far
    // more traffic than a contract-test run is expected to: once past the
    // cap, later exchanges are dropped (evaluation just runs against
    // whatever was captured) rather than growing this array — and thus
    // detour test's own memory footprint — without limit toward an OOM.
    if (exchanges.length >= MAX_CAPTURED_TEST_EXCHANGES) {
      if (!exchangeCapWarned) {
        console.error(
          `⚠ detour test has captured ${MAX_CAPTURED_TEST_EXCHANGES} exchanges and will stop recording more to bound memory use — results below only reflect the first ${MAX_CAPTURED_TEST_EXCHANGES}.`,
        );
        exchangeCapWarned = true;
      }
      return;
    }
    exchanges.push(exchange);
  });

  const handle = await startProxyServer({ port, ruleEngine }, eventBus);
  const proxyUrl = `http://localhost:${handle.port}`;
  console.log(`ℹ Proxy listening on ${proxyUrl} — running: ${command.join(' ')}`);

  try {
    const childExitCode = await runCommandUnderProxy(command, proxyUrl, handle.caCertPath);

    const results = evaluateAssertions(testFile.assertions, exchanges);
    console.log('');
    console.log(formatTestReport(results));

    const anyAssertionFailed = results.some((r) => !r.passed);
    if (childExitCode !== 0) {
      console.error(`✖ Command exited with code ${childExitCode}`);
      process.exitCode = childExitCode;
    } else if (anyAssertionFailed) {
      process.exitCode = 1;
    }
  } finally {
    await handle.stop();
  }
}

/** Wires `detour test` into the CLI. */
export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description(
      'Runs a command with HTTP_PROXY/HTTPS_PROXY pointed at a fresh proxy instance, then checks the captured traffic against a communication contract (header presence, PII leaks, p95 latency — issue #148)',
    )
    .argument('<command...>', 'Command to run under the proxy, e.g. `detour test -- npm run e2e`')
    .option(
      '--assertions <path>',
      `Path to a test assertions file (default: ${DEFAULT_TEST_ASSERTIONS_FILENAME} in the current directory)`,
      DEFAULT_TEST_ASSERTIONS_FILENAME,
    )
    .option(
      '--rules <path>',
      'Path to a rules file to apply while under test (e.g. to mock a flaky third-party dependency) — same format as `detour start --rules`, loaded once and not watched for changes.',
    )
    .option(
      '--allow-external-script-paths',
      "Allow a rule's `script.path`/`mock.bodyFile` to resolve outside the directory rules.json lives in (including an absolute path) instead of being rejected — see `detour start`'s flag of the same name.",
    )
    .option('-p, --port <port>', 'Port the proxy listens on (default: an ephemeral free port)', '0')
    .action(async (command: string[], options: TestOptions) => {
      try {
        await runTestCommand(command, options);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
