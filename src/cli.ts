import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { startDashboardServer, WEB_DIST_DIR } from './dashboard/dashboardServer';
import { DetourEventBus } from './eventBus';
import { logExchange, logProxyError } from './logger';
import { startProxyServer } from './proxyServer';
import { loadRulesFile } from './rules/loader';
import { RuleEngine } from './rules/ruleEngine';
import { SAMPLE_RULES_FILE } from './rules/sample';
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

interface StartOptions {
  port: string;
  dashboardPort: string;
  rules?: string;
}

async function runStart(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
  const dashboardPort = parsePort(options.dashboardPort, '--dashboard-port');

  const eventBus = new DetourEventBus();
  eventBus.on('response', logExchange);
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
      onReload: (info) => eventBus.emit('rulesReloaded', { filePath: ruleEngine!.filePath, ruleCount: info.ruleCount }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
  }

  const handle = await startProxyServer({ port, ruleEngine }, eventBus);
  let dashboardHandle;
  try {
    dashboardHandle = await startDashboardServer({ port: dashboardPort }, eventBus);
  } catch (err) {
    // The proxy is already up and intercepting traffic at this point — don't
    // leave it running (and the process alive) just because the dashboard
    // failed to bind its port.
    await handle.stop();
    throw err;
  }

  console.log(`Detour proxy started → http://localhost:${handle.port}`);
  console.log(`Root CA certificate: ${handle.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  if (fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
    console.log(`Dashboard → http://localhost:${dashboardHandle.port}`);
  } else {
    console.log(
      `Dashboard → http://localhost:${dashboardHandle.port} (not built yet — run \`npm run build\`, or use \`npm run dev:dashboard\` for a dev server with hot reload)`,
    );
  }
  if (ruleEngine) {
    console.log(
      `Rules file: ${ruleEngine.filePath} (loaded ${ruleEngine.getRules().length} rule(s), watching for changes)`,
    );
  }
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}. Stopping the proxy…`);
    await Promise.all([handle.stop(), dashboardHandle.stop()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export function createCli(): Command {
  const program = new Command();

  program.name('detour').description(pkg.description).version(pkg.version);

  program
    .command('start')
    .description('Starts the MITM proxy and begins capturing HTTP/HTTPS traffic')
    .option('-p, --port <port>', 'Port the proxy listens on', '8080')
    .option('--dashboard-port <port>', 'Port the web dashboard listens on', '4040')
    .option(
      '--rules <path>',
      `Path to a rules file. When given, mock/route/rewrite rules are applied and reloaded automatically on change (when omitted, ${DEFAULT_RULES_FILENAME} in the current directory is loaded automatically if present)`,
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
