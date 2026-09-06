import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { CliExitError } from './domain/daemon/errors';
import { isDumpLevel } from './domain/dump/dumpPolicy';
import type { DumpLevel } from './domain/dump/dumpPolicy';
import { SAMPLE_RULES_FILE } from './domain/rules/sample';
import { isSetupTarget, SETUP_TARGETS } from './domain/setup/targets';
import type { SetupTarget } from './domain/setup/targets';
import { hashDashboardPassword } from './infra/dashboard/dashboardPasswordHash';
import { startDashboardServer, WEB_DIST_DIR } from './infra/dashboard/dashboardServer';
import { DetourEventBus } from './infra/eventBus';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from './infra/fs/dumpFileWriter';
import {
  findLiveRunState,
  isProcessAlive,
  removeRunState,
  reserveRunState,
  writeRunState,
} from './infra/fs/runStateStore';
import { fsRuleProfileStore } from './infra/fs/ruleProfileStore';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter, loadRulesFile } from './infra/fs/rulesFileSource';
import type { UserConfig } from './infra/fs/userConfigStore';
import { loadUserConfig, resolveUserConfigPath, writeUserConfig } from './infra/fs/userConfigStore';
import { buildGrpcExchangeInfo } from './infra/grpc/grpcExchangeInfo';
import { ProtoRegistry } from './infra/grpc/protoRegistry';
import { lanAddresses } from './infra/network/lanAddresses';
import { isDaemonChild, signalDaemonError, signalDaemonReady, spawnDaemonChild } from './infra/process/daemonize';
import { nodeCommandRunner } from './infra/process/nodeCommandRunner';
import { openBrowser } from './infra/process/openBrowser';
import { caCertPath, ensureCaCert } from './infra/proxy/certExport';
import { startIdleWatcher } from './infra/proxy/idleWatcher';
import { nodeCertPairingServer } from './infra/proxy/nodeCertPairingServer';
import { startProxyServer } from './infra/proxy/proxyServer';
import {
  logExchange,
  logExchangeFull,
  logGrpcSection,
  logProxyError,
  logWebSocketConnection,
  logWebSocketFull,
} from './presentation/logger';
import { renderQrCode } from './presentation/qrCode';
import { RuleEngine } from './usecase/ruleEngine';
import { runTargets } from './usecase/setup/orchestrator';
import type { SetupMode, TargetReport } from './usecase/setup/orchestrator';
import type { SetupStep, StepStatus } from './usecase/setup/types';

// This file is Detour's composition root: the one place allowed to import
// across every layer (domain/usecase/infra/presentation) to wire concrete
// Infrastructure adapters (the real filesystem, ProxyEngine, ws) into
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

/** Validates `detour config --default-detach <on|off>` (and any future on/off config flag). Deliberately just "on"/"off" — not also "true"/"false" — so the accepted values and this error message never drift apart. */
function parseOnOff(value: string, flag: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${flag} must be "on" or "off" (got: ${value})`);
}

/** Validates `--exit-on-idle <ms>` (issue #20): a positive integer count of milliseconds. */
function parseIdleMs(value: string): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`--exit-on-idle must be a positive integer of milliseconds (got: ${value})`);
  }
  return ms;
}

/** Where a `--detach` daemon's stdout/stderr are appended (~/.detour/logs/<port>.log — one file per tracked port, overwritten across restarts of the same port isn't attempted; it just keeps growing, same as the console output a foreground run would otherwise produce). Mirrors `certStore.ts`'s `resolveCertDir`/`dumpFileWriter.ts`'s `resolveDumpDir`/`runStateStore.ts`'s `resolveRunDir`. */
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

/**
 * The core LAN-access security fact, worded once and reused everywhere
 * `--lan`/`lanAccess` is surfaced to the user: `--lan`'s own help text,
 * `detour config --lan`'s help text, and the startup banner's warning. One
 * shared string so refining the wording (or the security posture it
 * describes) can't drift between three independently hand-edited copies.
 *
 * `web/src/features/settings-panel/ui/SettingsPanel.tsx`'s dashboard-side
 * warning says the same thing in its own words — that's a separate,
 * standalone-built package with no access to this constant, so it's worded
 * to match by hand instead. Update both together.
 */
const LAN_ACCESS_WARNING =
  'there is no authentication of any kind — anyone on your network can reach the dashboard (and decrypted HTTPS traffic through it), edit rules, or use the proxy';

/** How long `detour stop` waits for a SIGTERM'd process to exit on its own before escalating to SIGKILL. */
const STOP_GRACE_PERIOD_MS = 10_000;

/** Shared by `detour status`/`detour stop` (issue #20) when nothing is tracked as running on `port`. */
function reportNotRunning(port: number): void {
  console.log(`detour is not running on port ${port}.`);
  process.exitCode = 1;
}

interface SetupCommandOptions {
  target?: string;
  port: string;
  host?: string;
}

/** One icon per `SetupStep['status']` — shared by `detour setup`/`doctor`/`cleanup`'s output (issue #65). */
function stepIcon(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '✔';
    case 'failed':
      return '✖';
    case 'skipped':
      return '⚠';
    case 'manual':
      return 'ℹ';
  }
}

/**
 * Steps already shown live via `onProgress` (currently only android.ts's
 * Wi-Fi/QR pairing step) land in `printedLive` — `printTargetReports`'s
 * later pass over the same step objects (they're the very same `SetupStep`
 * returned inside the final `TargetOutcome`, not copies) skips them rather
 * than printing the message — and re-rendering the QR code — a second time.
 */
const printedLive = new WeakSet<SetupStep>();

/**
 * QR rendering (`qrcode-terminal`) lives in `presentation/`, which
 * `usecase/setup` may not depend on (see `boundaries/dependencies` in
 * eslint.config.mjs) — so a step that wants one just carries the URL
 * (`SetupStep.qrUrl`) and this composition-root function does the actual
 * rendering. Shared by `printTargetReports`'s final pass over a completed
 * `TargetOutcome` and by `runSetupCommand`'s `onProgress` wiring below,
 * which calls this the moment a step is ready rather than only once
 * everything is (see `SetupContext.onProgress`'s doc comment — currently
 * just android.ts's Wi-Fi/QR pairing fallback, so its QR code is on screen
 * before its own multi-minute wait for a download, not just after).
 */
async function printStep(step: SetupStep): Promise<void> {
  printedLive.add(step);
  console.log(`  ${stepIcon(step.status)} ${step.message}`);
  if (step.qrUrl) console.log(await renderQrCode(step.qrUrl));
}

async function printTargetReports(reports: TargetReport[]): Promise<void> {
  for (const { target, outcome } of reports) {
    console.log(`\n${target}:`);
    for (const step of outcome.steps) {
      if (!printedLive.has(step)) await printStep(step);
    }
  }
}

/** `detour doctor`'s (and, less commonly, `setup`/`cleanup`'s) exit code: nonzero when anything came back `'failed'`, so it's scriptable in CI the way `detour status` already is. */
function hasFailedStep(reports: TargetReport[]): boolean {
  return reports.some(({ outcome }) => outcome.steps.some((step) => step.status === 'failed'));
}

/** Validates `--target`, narrowing it to `SetupTarget` — a plain guard clause doesn't narrow `options.target` itself since it's a mutable object property, so this gives `runSetupCommand` a local value TypeScript can track. */
function parseSetupTarget(value: string | undefined): SetupTarget | undefined {
  if (value === undefined) return undefined;
  if (!isSetupTarget(value)) throw new Error(`--target must be one of ${SETUP_TARGETS.join(', ')} (got: ${value})`);
  return value;
}

/**
 * Shared body for `detour setup`/`doctor`/`cleanup` (issue #65) — the three
 * commands differ only in which `SetupMode` they run and whether they issue
 * the CA cert (`setup`) or merely look for one already issued
 * (`doctor`/`cleanup`, which must never have the side effect of generating
 * one just by asking a readiness question).
 */
async function runSetupCommand(mode: SetupMode, options: SetupCommandOptions): Promise<void> {
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
      hostPlatform: process.platform,
      detectedLanAddresses: lanAddresses(),
      explicitTarget: target !== undefined,
      onProgress: printStep,
    });
    await printTargetReports(reports);
    if (hasFailedStep(reports) || (mode === 'doctor' && certMissing)) process.exitCode = 1;
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
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
  /** `--detach`: run as a background daemon; handled by `runDetached` before `runStart` is ever called for the parent process. Undefined unless the flag is actually passed — `resolveShouldDetach` also has `~/.detour/config.json`'s `defaultDetach` to fall back on, so "not passed" and "explicitly off" must stay distinguishable from each other (see `--foreground` for the latter). */
  detach?: boolean;
  /** `--foreground`: force foreground even when `defaultDetach` is on in `~/.detour/config.json` — the `--detach` counterpart for overriding that default back off for one run. */
  foreground?: boolean;
  /** `--no-open`: skip auto-opening the dashboard in a browser after startup. Defaults to `true` (auto-open on) via commander's `--no-<flag>` convention. */
  open: boolean;
  /** `--lan`/`--no-lan`: bind the proxy and dashboard to every network interface (`0.0.0.0`) instead of just `localhost`, for this invocation. Undefined when neither flag is passed — `resolveHost` then falls back to `~/.detour/config.json`'s `lanAccess`. Security-sensitive: see `UserConfigState.lanAccess`'s doc comment. */
  lan?: boolean;
}

/**
 * Whether this `start` invocation should run detached, folding together
 * three sources in priority order: an explicit `--foreground`/`--detach` on
 * the command line (rejected outright if both are given — there's no
 * sensible way to silently prefer one over the other), then
 * `~/.detour/config.json`'s `defaultDetach`, then plain foreground.
 *
 * Guarded by `isDaemonChild()` first: `runDetached` re-invokes this same
 * `start` command in a child process with `--detach` stripped from its argv
 * (see `runDetached`), relying on that child running foreground. Without
 * this guard, a `defaultDetach: true` config would make the child read the
 * same config, decide it too should detach, and spawn another daemon child
 * of its own — forever.
 */
function resolveShouldDetach(options: StartOptions): boolean {
  if (isDaemonChild()) return false;
  if (options.foreground && options.detach) {
    throw new Error('--foreground and --detach cannot be combined');
  }
  if (options.foreground) return false;
  if (options.detach) return true;
  return loadUserConfig().defaultDetach ?? false;
}

/**
 * Resolves the host the proxy and dashboard bind to for this `start`
 * invocation: `0.0.0.0` (every network interface) or `localhost`-only.
 * Folds together two sources, same priority as `resolveShouldDetach`'s
 * `--detach`/`--foreground`: an explicit `--lan`/`--no-lan` on the command
 * line, then `~/.detour/config.json`'s `lanAccess`, then `localhost`-only.
 *
 * Security-sensitive: LAN access has no authentication of its own, so
 * `0.0.0.0` means anything on the network can reach the dashboard (and,
 * from there, decrypted HTTPS traffic and rule edits) or use the proxy.
 */
function resolveHost(options: StartOptions): string {
  const lan = options.lan ?? loadUserConfig().lanAccess ?? false;
  return lan ? '0.0.0.0' : 'localhost';
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

/**
 * Whether `runStartBody` should fire the dashboard open in a browser after
 * binding it. Extracted as pure logic (rather than inlined at the one call
 * site) so the three exclusions are unit-testable without spawning a real
 * CLI process: `--no-open`, an ephemeral `dashboardPort` of 0 (only ever
 * produced by `--port 0` or an explicit `--dashboard-port 0`, both
 * test-only knobs — nothing a real user would want a browser pointed at,
 * since the actual bound port isn't known until after this runs), and a
 * dashboard that hasn't been built yet (`npm run build`), which would just
 * open a blank page.
 */
export function shouldAutoOpenDashboard(info: { open: boolean; dashboardPort: number; built: boolean }): boolean {
  return info.open && info.dashboardPort !== 0 && info.built;
}

/**
 * Validates flags, then — for `--fail-on-running` — atomically reserves the
 * run-state slot before any of the slower work in `runStartBody` (proto/
 * rules loading, the real port bind, the dashboard bind) so the check stays
 * reliable under two concurrent `--fail-on-running` starts (see
 * `reserveRunState`'s doc comment). If `runStartBody` fails for any other
 * reason after that reservation, it's released here before rethrowing —
 * this process never actually finished starting, so nothing should be left
 * looking like it's running on this port.
 */
async function runStart(options: StartOptions): Promise<void> {
  const port = parsePort(options.port, '--port');
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

  const reservedRunState = trackRunState && options.failOnRunning === true;
  if (reservedRunState) {
    const reserved = reserveRunState({
      pid: process.pid,
      requestedPort: port,
      // Placeholder until the real bind below resolves it (relevant if
      // --port were ever ephemeral here, which trackRunState rules out) —
      // overwritten by the unconditional `writeRunState` in `runStartBody`
      // once the actual proxy/dashboard ports are known.
      proxyPort: port,
      dashboardPort: undefined,
      headless,
      detached: isDaemonChild(),
      startedAt: Date.now(),
      logFile: process.env.DETOUR_LOG_FILE,
    });
    if (!reserved) {
      const existing = findLiveRunState(port);
      const detail = existing ? ` (pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()})` : '';
      throw new CliExitError(
        `detour is already running on port ${port}${detail}. Stop it first with \`detour stop --port ${port}\`.`,
        3,
      );
    }
  }

  try {
    await runStartBody({ port, headless, exitOnIdleMs, trackRunState, options });
  } catch (err) {
    if (reservedRunState) removeRunState(port);
    throw err;
  }
}

interface RunStartBodyContext {
  port: number;
  headless: boolean;
  exitOnIdleMs: number | undefined;
  trackRunState: boolean;
  options: StartOptions;
}

async function runStartBody({
  port,
  headless,
  exitOnIdleMs,
  trackRunState,
  options,
}: RunStartBodyContext): Promise<void> {
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

  const host = resolveHost(options);
  const handle = await startProxyServer({ port, host, ruleEngine, http2Enabled: options.http2 }, eventBus);
  // `--headless` (issue #20): CI/scripted use has no need for the web
  // dashboard — skip starting it entirely rather than starting it and just
  // not opening a browser to it.
  let dashboardHandle: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
  // The *requested* dashboard port (0 for an ephemeral `--dashboard-port 0`
  // or `--port 0`), kept separate from `dashboardHandle.port` (the real
  // OS-assigned port once bound, never 0) — `shouldAutoOpenDashboard` needs
  // the former to actually recognize the ephemeral-port case it's meant to
  // exclude.
  let requestedDashboardPort: number | undefined;
  if (!headless) {
    // Resolved only when actually needed: computed eagerly (outside this
    // `if`), a `--port` close enough to 65535 that only its +1000 offset
    // would overflow could fail this validation even under `--headless`,
    // where no dashboard port is ever bound at all.
    requestedDashboardPort = resolveDashboardPort(port, options.dashboardPort);
    try {
      dashboardHandle = await startDashboardServer(
        {
          port: requestedDashboardPort,
          host,
          proxyPort: handle.port,
          ruleEngine,
          ruleProfileStore: fsRuleProfileStore,
          // Only actually populated when bound to every interface — see
          // `DashboardServerOptions.lanAddresses`'s doc comment (issue #66).
          lanAddresses: host !== 'localhost' ? lanAddresses() : [],
        },
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

  // Deliberately after every fallible startup step above (dashboard bind,
  // run-state write) has committed — opening a browser tab and then tearing
  // the dashboard back down moments later because one of those failed would
  // just leave the user staring at a connection-refused page.
  if (
    dashboardHandle &&
    requestedDashboardPort !== undefined &&
    shouldAutoOpenDashboard({ open: options.open, dashboardPort: requestedDashboardPort, built: isDashboardBuilt() })
  ) {
    openBrowser(`http://localhost:${dashboardHandle.port}`);
  }

  printStartupBanner({
    host,
    proxyPort: handle.port,
    caCertPath: handle.caCertPath,
    dashboardPort: dashboardHandle?.port,
    ruleEngine,
    dumpDir,
    http2Enabled: options.http2,
    protoPaths: options.proto,
    dashboardPasswordSet: !!loadUserConfig().dashboardPasswordHash,
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

/** Whether `npm run build` has produced a dashboard SPA to serve — shared by the startup banner's "not built yet" message and the `--open` auto-launch's decision not to open a blank page. */
function isDashboardBuilt(): boolean {
  return fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'));
}

function printStartupBanner(info: {
  host: string;
  proxyPort: number;
  caCertPath: string;
  /** Undefined when started with `--headless`. */
  dashboardPort: number | undefined;
  ruleEngine: RuleEngine | undefined;
  dumpDir: string | undefined;
  http2Enabled: boolean;
  protoPaths: string[];
  /** Whether `detour config --dashboard-password`/the Settings panel currently requires one (issue #66) — only relevant when `dashboardPort` isn't undefined. */
  dashboardPasswordSet: boolean;
}): void {
  console.log(
    `Detour proxy started → http://localhost:${info.proxyPort} (HTTP/2: ${info.http2Enabled ? 'on' : 'off'})`,
  );
  console.log(`Root CA certificate: ${info.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  if (info.dashboardPort === undefined) {
    console.log('Dashboard → disabled (--headless)');
  } else if (isDashboardBuilt()) {
    console.log(`Dashboard → http://localhost:${info.dashboardPort}`);
  } else {
    console.log(
      `Dashboard → http://localhost:${info.dashboardPort} (not built yet — run \`npm run build\`, or use \`npm run dev:dashboard\` for a dev server with hot reload)`,
    );
  }
  if (info.dashboardPort !== undefined) {
    console.log(
      `Dashboard password: ${info.dashboardPasswordSet ? 'required' : 'off (detour config --dashboard-password <value>)'}`,
    );
  }
  // `--lan`/`detour config --lan on`: called out loudly rather than folded
  // quietly into the URLs above — LAN access has no authentication of its
  // own, so anyone on the network can reach the dashboard (and from there,
  // decrypted HTTPS traffic and rule edits) or use the proxy.
  if (info.host !== 'localhost') {
    // `localhost` on a *different* device resolves to that device, not this
    // machine — the URLs printed above are useless to whoever's supposed to
    // reach this from elsewhere on the network. Print every real address
    // this machine actually has instead.
    const addresses = lanAddresses();
    if (addresses.length > 0) {
      console.log('Reachable on your network at:');
      for (const address of addresses) {
        console.log(`  Proxy     → http://${address}:${info.proxyPort}`);
        if (info.dashboardPort !== undefined) console.log(`  Dashboard → http://${address}:${info.dashboardPort}`);
      }
    }
    console.log(
      `⚠ Bound to every network interface (${info.host}), not just this machine — SECURITY: ${LAN_ACCESS_WARNING}. Only do this on a network you trust.`,
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
      '--no-open',
      'Skip auto-opening the dashboard in a default browser after startup (on by default; has no effect under --headless).',
    )
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
      'Start as a background daemon and return once it reports ready (issue #20) — manage it afterwards with `detour status`/`detour stop`; its output goes to ~/.detour/logs/<port>.log instead of this terminal. On by default if `defaultDetach` is set via `detour config`.',
    )
    .option(
      '--foreground',
      'Run in the foreground for this invocation even if `defaultDetach` is enabled via `detour config` — the opposite of --detach.',
    )
    .option(
      '--lan',
      `Bind the proxy and dashboard to every network interface (0.0.0.0) instead of just this machine, for this invocation. SECURITY: ${LAN_ACCESS_WARNING}. On by default if \`lanAccess\` is set via \`detour config\`.`,
    )
    .option(
      '--no-lan',
      'Force localhost-only for this invocation even if `lanAccess` is enabled via `detour config` — the opposite of --lan.',
    )
    .action(async (options: StartOptions) => {
      try {
        if (resolveShouldDetach(options)) {
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
      try {
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
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('stop')
    .description('Stops a detour instance (--detach or foreground) running on the given --port (issue #20)')
    .option('-p, --port <port>', 'Port of the instance to stop (matches the --port it was given)', '8080')
    .action(async (options: { port: string }) => {
      try {
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
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  /**
   * Formats one `detour config` patch field for the "✔ key = value" line
   * printed after a write — `dashboardPasswordHash` gets special-cased
   * (renamed, and reported as on/off rather than the hash itself) since it's
   * the one field here that's never safe to print as-is.
   */
  function describeWrittenConfigField(key: string, written: UserConfig): [label: string, value: unknown] {
    if (key === 'dashboardPasswordHash') return ['dashboardPassword', written.dashboardPasswordHash ? 'on' : 'off'];
    return [key, written[key]];
  }

  program
    .command('config')
    .description('View or change persistent `detour start` preferences, stored in ~/.detour/config.json')
    .option(
      '--default-detach <on|off>',
      'When "on", `detour start` runs detached by default (as if --detach were always passed) — override per-invocation with --detach/--foreground.',
    )
    .option(
      '--lan <on|off>',
      `When "on", \`detour start\` binds the proxy and dashboard to every network interface (0.0.0.0) by default — override per-invocation with --lan/--no-lan. SECURITY: ${LAN_ACCESS_WARNING}.`,
    )
    .option(
      '--dashboard-password <value>',
      'Require this password before the dashboard will send any traffic, rules, or accept any control message over its WebSocket connection (issue #66). Pass "off" to remove it. Independent of --lan; takes effect for new connections immediately (no restart needed); stored hashed, never in plaintext.',
    )
    .action((options: { defaultDetach?: string; lan?: string; dashboardPassword?: string }) => {
      try {
        const patch: UserConfig = {};
        if (options.defaultDetach !== undefined)
          patch.defaultDetach = parseOnOff(options.defaultDetach, '--default-detach');
        if (options.lan !== undefined) patch.lanAccess = parseOnOff(options.lan, '--lan');
        if (options.dashboardPassword !== undefined) {
          patch.dashboardPasswordHash =
            options.dashboardPassword === 'off' ? null : hashDashboardPassword(options.dashboardPassword);
        }

        if (Object.keys(patch).length > 0) {
          const written = writeUserConfig(patch);
          for (const key of Object.keys(patch)) {
            const [label, value] = describeWrittenConfigField(key, written);
            console.log(`✔ ${label} = ${value} (${resolveUserConfigPath()})`);
          }
          return;
        }
        const config = loadUserConfig();
        console.log(`defaultDetach = ${config.defaultDetach ?? false}`);
        console.log(`lanAccess = ${config.lanAccess ?? false}`);
        console.log(`dashboardPassword = ${config.dashboardPasswordHash ? 'on' : 'off'}`);
        console.log(`Config file: ${resolveUserConfigPath()}`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
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
