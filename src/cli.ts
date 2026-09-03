import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { isDumpLevel } from './domain/dump/dumpPolicy';
import type { DumpLevel } from './domain/dump/dumpPolicy';
import { SAMPLE_RULES_FILE } from './domain/rules/sample';
import { startDashboardServer, WEB_DIST_DIR } from './infra/dashboard/dashboardServer';
import { DetourEventBus } from './infra/eventBus';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from './infra/fs/dumpFileWriter';
import { fsRuleProfileStore } from './infra/fs/ruleProfileStore';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter, loadRulesFile } from './infra/fs/rulesFileSource';
import { buildGrpcExchangeInfo } from './infra/grpc/grpcExchangeInfo';
import { ProtoRegistry } from './infra/grpc/protoRegistry';
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

/** Accumulates repeated `--proto <path>` flags into an array (commander's convention for a repeatable option). */
function collectProtoPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Dashboard defaults to this many ports above the proxy (e.g. proxy 8080 → dashboard 9080) when `--dashboard-port` isn't given explicitly. */
const DEFAULT_DASHBOARD_PORT_OFFSET = 1000;

interface StartOptions {
  port: string;
  /** Undefined when `--dashboard-port` wasn't passed — defaults to `port + 1000` rather than a fixed value, so it tracks whatever `--port` was chosen (issue #24). */
  dashboardPort?: string;
  rules?: string;
  dump: string;
  http2: boolean;
  proto: string[];
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
  let dashboardHandle;
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

  printStartupBanner({
    proxyPort: handle.port,
    caCertPath: handle.caCertPath,
    dashboardPort: dashboardHandle.port,
    ruleEngine,
    dumpDir,
    http2Enabled: options.http2,
    protoPaths: options.proto,
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}. Stopping the proxy…`);
    await Promise.all([handle.stop(), dashboardHandle.stop()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function printStartupBanner(info: {
  proxyPort: number;
  caCertPath: string;
  dashboardPort: number;
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
  if (fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
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
      `Path to a rules file. When given, mock/route/rewrite rules are applied and reloaded automatically on change (when omitted, ${DEFAULT_RULES_FILENAME} in the current directory is loaded automatically if present)`,
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
    .action(async (options: StartOptions) => {
      try {
        await runStart(options);
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
