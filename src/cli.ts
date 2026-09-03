import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { CliExitError } from './domain/daemon/errors';
import { isDumpLevel } from './domain/dump/dumpPolicy';
import type { DumpLevel } from './domain/dump/dumpPolicy';
import { SAMPLE_RULES_FILE } from './domain/rules/sample';
import { startDashboardServer, WEB_DIST_DIR } from './infra/dashboard/dashboardServer';
import { DetourEventBus } from './infra/eventBus';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from './infra/fs/dumpFileWriter';
import { findLiveRunState, isProcessAlive, removeRunState, writeRunState } from './infra/fs/runStateStore';
import { fsRuleProfileStore } from './infra/fs/ruleProfileStore';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter, loadRulesFile } from './infra/fs/rulesFileSource';
import { buildGrpcExchangeInfo } from './infra/grpc/grpcExchangeInfo';
import { ProtoRegistry } from './infra/grpc/protoRegistry';
import { isDaemonChild, signalDaemonError, signalDaemonReady, spawnDaemonChild } from './infra/process/daemonize';
import { ensureCaCert } from './infra/proxy/certExport';
import { startIdleWatcher } from './infra/proxy/idleWatcher';
import { startProxyServer } from './infra/proxy/proxyServer';
import {
  logExchange,
  logExchangeFull,
  logGrpcSection,
  logProxyError,
  logWebSocketConnection,
  logWebSocketFull,
} from './presentation/logger';
import { RuleEngine } from './usecase/ruleEngine';

// This file is Detour's composition root: the one place allowed to import
// across every layer (domain/usecase/infra/presentation) to wire concrete
// Infrastructure adapters (the real filesystem, http-mitm-proxy, ws) into
// the UseCases that only depend on their ports. Everything under
// domain/usecase/infra/presentation is checked by
// `boundaries/element-types` (see eslint.config.mjs); this file — and
// cli.e2e.test.ts, which drives it as a black box — deliberately sit
// outside those directories so this wiring has somewhere to live.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- reads package.json at runtime; a static `import` would need resolveJsonModule wired through the CJS build.
const pkg = require('../package.json') as { version: string; description: string };

/** Auto-loaded when `--rules` isn't given and this file exists in the current directory. */
const DEFAULT_RULES_FILENAME = 'passthrough.rule.json';

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${flag} must be an integer between 0 and 65535 (got: ${value})`);
  }
  return port;
}

function parseDumpLevel(value: string): DumpLevel {
  if (!isDumpLevel(value)) {
    throw new Error(`--dump must be one of "summary", "full", "file" (got: ${value})`);
  }
  return value;
}

/** Validates `--exit-on-idle <ms>` (issue #20): a positive integer count of milliseconds. */
function parseIdleMs(value: string): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`--exit-on-idle must be a positive integer of milliseconds (got: ${value})`);
  }
  return ms;
}

/** Where a `--detach` daemon's stdout/stderr are appended (~/.detour/logs/<port>.log — one file per tracked port, overwritten across restarts of the same port isn't attempted; it just keeps growing, same as the console output a foreground run would otherwise produce). */
function resolveLogFilePath(port: number): string {
  const dir = path.join(os.homedir(), '.detour', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${port}.log`);
}

/** Accumulates repeated `--proto <path>` flags into an array (commander's convention for a repeatable option). */
function collectProtoPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Dashboard defaults to this many ports above the proxy (e.g. proxy 8080 → dashboard 9080) when `--dashboard-port` isn't given explicitly. */
const DEFAULT_DASHBOARD_PORT_OFFSET = 1000;

/** How long `detour stop` waits for a SIGTERM'd process to exit on its own before escalating to SIGKILL. */
const STOP_GRACE_PERIOD_MS = 10_000;

/** Shared by `detour status`/`detour stop` (issue #20) when nothing is tracked as running on `port`. */
function reportNotRunning(port: number): void {
  console.log(`detour is not running on port ${port}.`);
  process.exitCode = 1;
}

interface StartOptions {
  port: string;
  /** Undefined when `--dashboard-port` wasn't passed — defaults to `port + 1000` rather than a fixed value, so it tracks whatever `--port` was chosen (issue #24). */
  dashboardPort?: string;
  rules?: string;
  dump: string;
  http2: boolean;
  proto: string[];
  /** `--headless` (issue #20): skip starting the web dashboard entirely — proxy-only, for CI/scripted use. */
  headless?: boolean;
  /** `--exit-on-idle <ms>` (issue #20), unparsed. */
  exitOnIdle?: string;
  /** `--fail-on-running` (issue #20): exit 3 instead of starting if detour is already tracked as running on this `--port`. */
  failOnRunning?: boolean;
  /** `--detach` (issue #20): run as a background daemon; handled by `runDetached` before `runStart` is ever called for the parent process. */
  detach?: boolean;
}

/**
 * Resolves the dashboard's port: the explicit `--dashboard-port` value if
 * given, otherwise `proxyPort + 1000` (issue #24's port spec — was a fixed
 * `4040` default before this). Ephemeral proxy ports (`--port 0`, used by
 * the test suite) skip the offset entirely — `0 + 1000` would silently stop
 * being ephemeral, defeating the point of asking for one — and fall back to
 * `0` (also ephemeral) so tests keep getting an unused port without needing
 * to pass `--dashboard-port 0` explicitly.
 */
export function resolveDashboardPort(proxyPort: number, explicit: string | undefined): number {
  if (explicit !== undefined) return parsePort(explicit, '--dashboard-port');
  if (proxyPort === 0) return 0;
  const derived = proxyPort + DEFAULT_DASHBOARD_PORT_OFFSET;
  if (derived > 65535) {
    throw new Error(
      `--port ${proxyPort} + ${DEFAULT_DASHBOARD_PORT_OFFSET} would exceed the maximum port 65535 — pass --dashboard-port explicitly`,
    );
  }
  return derived;
}

async function runStart(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
  const dashboardPort = resolveDashboardPort(port, options.dashboardPort);
  const dumpLevel = parseDumpLevel(options.dump);
  const dumpDir = dumpLevel === 'file' ? resolveDumpDir() : undefined;
  const headless = options.headless ?? false;
  const exitOnIdleMs = options.exitOnIdle !== undefined ? parseIdleMs(options.exitOnIdle) : undefined;

  // Run-state tracking (backs "Fail on Running", `detour status`, `detour
  // stop` — issue #20) is keyed by the requested `--port`, so an ephemeral
  // `--port 0` — which has no stable value to be looked up by later — simply
  // isn't tracked. `--fail-on-running` explicitly asked for that lookup, so
  // it fails loudly instead of silently no-op'ing.
  const trackRunState = port !== 0;
  if (options.failOnRunning && !trackRunState) {
    throw new Error(
      '--fail-on-running requires an explicit --port (an ephemeral "--port 0" has no stable port to check)',
    );
  }
  if (trackRunState && options.failOnRunning) {
    const existing = findLiveRunState(port);
    if (existing) {
      throw new CliExitError(
        `detour is already running on port ${port} (pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}). Stop it first with \`detour stop --port ${port}\`.`,
        3,
      );
    }
  }

  // Loaded eagerly (like rules.json below) so a broken .proto schema fails
  // CLI startup with a clear error, rather than every gRPC exchange
  // silently falling back to "no --proto configured" for the whole session.
  const protoRegistry = options.proto.length > 0 ? await ProtoRegistry.load(options.proto) : undefined;

  const eventBus = new DetourEventBus();
  eventBus.on('response', (exchange) => {
    logExchange(exchange);
    // Decoding (and, for a compressed frame, decompressing) every gRPC
    // message is real work — skip it entirely at the default `summary`
    // level, where the result would never be printed or written anyway.
    const grpcInfo = dumpLevel !== 'summary' ? buildGrpcExchangeInfo(exchange, protoRegistry) : undefined;
    if (dumpLevel === 'full') {
      logExchangeFull(exchange);
      if (grpcInfo) logGrpcSection(grpcInfo);
    }
    if (dumpDir) writeExchangeDumpFile(exchange, dumpDir, grpcInfo);
  });
  // Logged once the WebSocket connection closes (its one clear "done"
  // point), mirroring 'response' above — not on every frame, which would
  // spam the console for a chatty socket.
  eventBus.on('wsClose', (connection) => {
    logWebSocketConnection(connection);
    if (dumpLevel === 'full') logWebSocketFull(connection);
    if (dumpDir) writeWebSocketDumpFile(connection, dumpDir);
  });
  eventBus.on('error', logProxyError);
  eventBus.on('rulesReloaded', ({ filePath, ruleCount }) => {
    console.log(`↻ Reloaded rules (${ruleCount}): ${filePath}`);
  });

  let ruleEngine: RuleEngine | undefined;
  const autoDetected = !options.rules && fs.existsSync(path.resolve(process.cwd(), DEFAULT_RULES_FILENAME));
  const rulesPath = options.rules ?? (autoDetected ? DEFAULT_RULES_FILENAME : undefined);
  if (rulesPath) {
    if (autoDetected)
      console.log(`ℹ Found ${DEFAULT_RULES_FILENAME}, loading it as rules (pass --rules to use a different file)`);
    // Load eagerly so a broken rules.json fails CLI startup with a clear
    // error, rather than the proxy silently starting without any rules.
    ruleEngine = RuleEngine.load({
      filePath: rulesPath,
      reader: fsRulesFileReader,
      writer: fsRulesFileWriter,
      watcher: fsFileWatcher,
      onReload: (info) => eventBus.emit('rulesReloaded', { filePath: ruleEngine!.filePath, ruleCount: info.ruleCount }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
  }

  const handle = await startProxyServer({ port, ruleEngine, http2Enabled: options.http2 }, eventBus);
  // `--headless` (issue #20): CI/scripted use has no need for the web
  // dashboard — skip starting it entirely rather than starting it and just
  // not opening a browser to it (there's no browser-open behavior to skip
  // yet either way).
  let dashboardHandle: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
  if (!headless) {
    try {
      dashboardHandle = await startDashboardServer(
        { port: dashboardPort, proxyPort: handle.port, ruleEngine, ruleProfileStore: fsRuleProfileStore },
        eventBus,
      );
    } catch (err) {
      // The proxy is already up and intercepting traffic at this point — don't
      // leave it running (and the process alive) just because the dashboard
      // failed to bind its port.
      await handle.stop();
      throw err;
    }
  }

  if (trackRunState) {
    try {
      writeRunState({
        pid: process.pid,
        requestedPort: port,
        proxyPort: handle.port,
        dashboardPort: dashboardHandle?.port,
        headless,
        detached: isDaemonChild(),
        startedAt: Date.now(),
        logFile: process.env.DETOUR_LOG_FILE,
      });
    } catch (err) {
      // The proxy (and dashboard) are already up at this point — an
      // unwritable ~/.detour/run (e.g. disk full, permissions) shouldn't
      // leave them running with no corresponding run-state entry: `detour
      // status`/`stop`/`--fail-on-running` would then have no way to find
      // this process at all. Same shutdown-before-rethrow shape as the
      // dashboard bind failure above.
      await Promise.all([handle.stop(), dashboardHandle?.stop()]);
      throw err;
    }
  }

  printStartupBanner({
    proxyPort: handle.port,
    caCertPath: handle.caCertPath,
    dashboardPort: dashboardHandle?.port,
    ruleEngine,
    dumpDir,
    http2Enabled: options.http2,
    protoPaths: options.proto,
  });

  // DETOUR_READY (issue #20): a stable, greppable line a CI script can wait
  // on to know the proxy (and dashboard, unless --headless) actually
  // finished binding its port(s) — printed unconditionally, not just under
  // --headless, since a foreground non-CI run benefits from it too. When
  // running as a `--detach` daemon child (see `isDaemonChild`), this also
  // unblocks the parent's `spawnDaemonChild` handshake — a no-op otherwise.
  const dashboardPortSegment = dashboardHandle ? ` dashboardPort=${dashboardHandle.port}` : '';
  console.log(`DETOUR_READY proxyPort=${handle.port}${dashboardPortSegment} pid=${process.pid}`);
  signalDaemonReady({ proxyPort: handle.port, dashboardPort: dashboardHandle?.port });

  let idleWatcher: ReturnType<typeof startIdleWatcher> | undefined;

  const shutdown = async (reason: NodeJS.Signals | 'idle') => {
    console.log(
      reason === 'idle'
        ? `\nNo activity for ${exitOnIdleMs}ms — exiting (--exit-on-idle).`
        : `\nReceived ${reason}. Stopping the proxy…`,
    );
    idleWatcher?.stop();
    let stopError: unknown;
    try {
      await Promise.all([handle.stop(), dashboardHandle?.stop()]);
    } catch (err) {
      stopError = err;
    }
    // Removed only once the stop attempt has actually settled (success or
    // failure), not before — removing it first would let a concurrent
    // `detour status`/`--fail-on-running` briefly see "not running" while
    // the servers (and this process) are still very much alive.
    if (trackRunState) removeRunState(port);
    if (stopError) {
      console.error(`✖ ${stopError instanceof Error ? stopError.message : String(stopError)}`);
      process.exit(1);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (exitOnIdleMs !== undefined) {
    idleWatcher = startIdleWatcher(eventBus, exitOnIdleMs, () => void shutdown('idle'));
  }
}

function printStartupBanner(info: {
  proxyPort: number;
  caCertPath: string;
  /** Undefined when started with `--headless`. */
  dashboardPort: number | undefined;
  ruleEngine: RuleEngine | undefined;
  dumpDir: string | undefined;
  http2Enabled: boolean;
  protoPaths: string[];
}): void {
  console.log(
    `Detour proxy started → http://localhost:${info.proxyPort} (HTTP/2: ${info.http2Enabled ? 'on' : 'off'})`,
  );
  console.log(`Root CA certificate: ${info.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  if (info.dashboardPort === undefined) {
    console.log('Dashboard → disabled (--headless)');
  } else if (fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
    console.log(`Dashboard → http://localhost:${info.dashboardPort}`);
  } else {
    console.log(
      `Dashboard → http://localhost:${info.dashboardPort} (not built yet — run \`npm run build\`, or use \`npm run dev:dashboard\` for a dev server with hot reload)`,
    );
  }
  if (info.ruleEngine) {
    console.log(
      `Rules file: ${info.ruleEngine.filePath} (loaded ${info.ruleEngine.getRules().length} rule(s), watching for changes)`,
    );
  }
  if (info.dumpDir) {
    console.log(`Full request/response dumps → ${info.dumpDir}`);
  }
  if (info.protoPaths.length > 0) {
    console.log(`gRPC message decoding: ${info.protoPaths.length} .proto file(s) loaded`);
  }
  console.log('Press Ctrl+C to stop.');
}

/**
 * `--detach` (issue #20): re-invokes `detour start` (same entry point, same
 * argv minus `--detach` itself) as a detached background process and waits
 * for it to report readiness before returning — see `spawnDaemonChild`'s
 * doc comment for the IPC handshake this relies on, and `signalDaemonReady`/
 * `signalDaemonError` in `runStart`/the `start` action for the child side of
 * it. `detour status`/`detour stop --port <n>` manage the daemon afterwards.
 */
async function runDetached(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
  if (port === 0) {
    throw new Error(
      '--detach requires an explicit --port (an ephemeral "--port 0" can\'t be reconnected to afterwards)',
    );
  }
  const childArgs = process.argv.slice(3).filter((arg) => arg !== '--detach');
  const logFile = resolveLogFilePath(port);
  const info = await spawnDaemonChild({ scriptPath: process.argv[1]!, args: ['start', ...childArgs], logFile });

  console.log(`✔ detour started in the background (pid ${info.pid})`);
  console.log(`  Proxy     → http://localhost:${info.proxyPort}`);
  if (info.dashboardPort !== undefined) console.log(`  Dashboard → http://localhost:${info.dashboardPort}`);
  console.log(`  Logs      → ${logFile}`);
  console.log(`  Stop with: detour stop --port ${port}`);
}

export function createCli(): Command {
  const program = new Command();

  program.name('detour').description(pkg.description).version(pkg.version);

  program
    .command('start')
    .description('Starts the MITM proxy and begins capturing HTTP/HTTPS traffic')
    .option('-p, --port <port>', 'Port the proxy listens on', '8080')
    .option(
      '--dashboard-port <port>',
      `Port the web dashboard listens on (default: --port + ${DEFAULT_DASHBOARD_PORT_OFFSET}, e.g. 9080 for the default proxy port 8080)`,
    )
    .option(
      '--rules <path>',
      `Path to a rules file. When given, mock/route/rewrite/script rules are applied and reloaded automatically on change (when omitted, ${DEFAULT_RULES_FILENAME} in the current directory is loaded automatically if present)`,
    )
    .option(
      '--dump <level>',
      'Verbosity of the request/response log: "summary" (default, one line per exchange), "full" (also prints headers/body to the console, sensitive headers redacted), or "file" (also writes a redacted dump per exchange to ~/.detour/dumps)',
      'summary',
    )
    .option(
      '--no-http2',
      "Disable HTTP/2 (ALPN) on MITM'd HTTPS connections — every intercepted host falls back to HTTP/1.1 only, matching Detour's behavior before this flag existed. HTTP/2 is negotiated with the client by default; the connection to the real upstream server is always HTTP/1.1 either way.",
    )
    .option(
      '--proto <path>',
      'Path to a .proto file used to decode gRPC (application/grpc*) message bodies. Repeatable for a schema split across multiple files sharing imports. Detection of gRPC traffic itself always happens, with or without this flag.',
      collectProtoPath,
      [],
    )
    .option('--headless', 'Skip starting the web dashboard entirely — proxy-only, for CI/scripted use (issue #20).')
    .option(
      '--exit-on-idle <ms>',
      'Exit automatically after this many milliseconds with no proxied HTTP/WebSocket activity (issue #20) — so a CI job never has to send it a Ctrl+C of its own.',
    )
    .option(
      '--fail-on-running',
      'Exit with code 3 instead of starting if detour is already tracked as running on this --port (issue #20), rather than the generic port-in-use error.',
    )
    .option(
      '--detach',
      'Start as a background daemon and return once it reports ready (issue #20) — manage it afterwards with `detour status`/`detour stop`; its output goes to ~/.detour/logs/<port>.log instead of this terminal.',
    )
    .action(async (options: StartOptions) => {
      try {
        if (options.detach) {
          await runDetached(options);
          return;
        }
        await runStart(options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exitCode = err instanceof CliExitError ? err.exitCode : 1;
        // Running as a `--detach` daemon child (see `isDaemonChild`): tell
        // the parent's `spawnDaemonChild` handshake why startup failed
        // instead of leaving it to time out — a no-op in every other case.
        if (isDaemonChild()) signalDaemonError(message, exitCode);
        console.error(`✖ ${message}`);
        process.exitCode = exitCode;
      }
    });

  program
    .command('status')
    .description('Shows whether a detour instance (--detach or foreground) is running on the given --port (issue #20)')
    .option('-p, --port <port>', 'Port to check (matches the --port a `detour start` was given)', '8080')
    .action((options: { port: string }) => {
      const port = parsePort(options.port, '--port');
      const state = findLiveRunState(port);
      if (!state) {
        reportNotRunning(port);
        return;
      }
      console.log(
        `✔ detour is running on port ${port} (pid ${state.pid}${state.detached ? ', detached' : ', foreground'})`,
      );
      console.log(`  Proxy     → http://localhost:${state.proxyPort}`);
      console.log(
        state.dashboardPort !== undefined
          ? `  Dashboard → http://localhost:${state.dashboardPort}`
          : '  Dashboard → disabled (--headless)',
      );
      console.log(`  Started   → ${new Date(state.startedAt).toISOString()}`);
      if (state.logFile) console.log(`  Logs      → ${state.logFile}`);
    });

  program
    .command('stop')
    .description('Stops a detour instance (--detach or foreground) running on the given --port (issue #20)')
    .option('-p, --port <port>', 'Port of the instance to stop (matches the --port it was given)', '8080')
    .action(async (options: { port: string }) => {
      const port = parsePort(options.port, '--port');
      const state = findLiveRunState(port);
      if (!state) {
        reportNotRunning(port);
        return;
      }
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
      const deadline = Date.now() + STOP_GRACE_PERIOD_MS;
      while (isProcessAlive(state.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isProcessAlive(state.pid)) {
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
      // Self-healing (see findLiveRunState): normally the process removes
      // its own state file as part of graceful shutdown, but a SIGKILL after
      // the grace period skips that — clean it up here either way.
      removeRunState(port);
      console.log(`✔ Stopped detour (pid ${state.pid}) on port ${port}.`);
    });

  const cert = program
    .command('cert')
    .description('Manage the local root CA certificate used to decrypt HTTPS traffic');

  cert
    .command('export [path]')
    .description(
      'Writes the CA certificate to <path> (or prints it to stdout if omitted) — generates it first if detour has never run on this machine before (issue #20).',
    )
    .action(async (destPath?: string) => {
      try {
        const certPath = await ensureCaCert();
        const pem = fs.readFileSync(certPath, 'utf8');
        if (!destPath) {
          process.stdout.write(pem);
          return;
        }
        const dest = path.resolve(destPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, pem);
        console.log(`✔ Exported CA certificate to ${dest}`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const rules = program.command('rules').description('Manage rules.json (the declarative rule engine config)');

  rules
    .command('validate <path>')
    .description("Validates a rules file against the schema and Detour's semantic rules")
    .action((rulesPath: string) => {
      try {
        const { rules: loaded } = loadRulesFile(path.resolve(rulesPath));
        console.log(`✔ ${rulesPath} is valid (${loaded.length} rule(s))`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  rules
    .command('init [path]')
    .description('Creates a sample rules file')
    .action((rulesPath = 'rules.json') => {
      const dest = path.resolve(rulesPath);
      if (fs.existsSync(dest)) {
        console.error(`✖ Already exists: ${dest}`);
        process.exitCode = 1;
        return;
      }
      fs.writeFileSync(dest, SAMPLE_RULES_FILE);
      console.log(`✔ Created sample rules file: ${dest}`);
    });

  return program;
}

// Runs the CLI when this file is executed directly (`tsx src/cli.ts ...`,
// `npm run dev`) — but stays a pure module (no side effect) when merely
// imported, e.g. by `bin/detour.js` (which requires the *built* `dist/cli.js`
// and calls `.parse()` itself) or by tests importing `createCli` without
// wanting it to run.
if (require.main === module) {
  createCli().parse(process.argv);
}
