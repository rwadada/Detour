import path from 'node:path';
import type { Command } from 'commander';
import { FixtureStore } from '../domain/record/fixtureStore';
import { startFixtureServer } from '../infra/fixtureServer';
import { loadFixtureFiles } from '../infra/fs/fixtureFileSource';
import { describeError, parsePort } from './optionParsers';

interface ServeOptions {
  port: string;
}

/**
 * `detour serve <dir>` (issue #149): replays fixtures recorded by `detour
 * record` as a plain HTTP mock server — no proxy, no TLS interception, no
 * `HTTP_PROXY` env var for the client to set. A test's own HTTP client
 * points its base URL directly at this server instead. Runs in the
 * foreground until interrupted (`Ctrl+C`/`SIGTERM`) — there's no proxy or
 * dashboard state here needing the graceful multi-step shutdown `detour
 * start` has, so Node's own default signal handling is enough.
 */
export async function runServeCommand(dir: string, options: ServeOptions): Promise<void> {
  const fixturesDir = path.resolve(dir);
  const fixtures = loadFixtureFiles(fixturesDir);
  if (fixtures.length === 0) {
    console.error(`⚠ No fixtures found in ${fixturesDir} — every request will get a 404.`);
  }

  const handle = await startFixtureServer({
    store: new FixtureStore(fixtures),
    port: parsePort(options.port, '--port'),
    onError: (err) => console.error(`✖ detour serve error: ${describeError(err)}`),
  });

  console.log(`DETOUR_SERVE_READY port=${handle.port} fixtures=${fixtures.length} dir=${fixturesDir}`);
}

/** Wires `detour serve` into the CLI. */
export function registerServeCommand(program: Command): void {
  program
    .command('serve <dir>')
    .description(
      "Replays fixtures recorded by `detour record` as a plain HTTP mock server — no proxy, no TLS interception; point a test's own HTTP client base URL directly at it instead (issue #149)",
    )
    .option('-p, --port <port>', 'Port the mock server listens on', '8081')
    .action(async (dir: string, options: ServeOptions) => {
      try {
        await runServeCommand(dir, options);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
