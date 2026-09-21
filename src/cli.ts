import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { caExpiryWarning, type CaValidityReport, caValidityReport } from './domain/cert/caValidity';
import { CliExitError } from './domain/daemon/errors';
import { isDumpLevel } from './domain/dump/dumpPolicy';
import type { DumpLevel } from './domain/dump/dumpPolicy';
import type { CapturedExchange } from './domain/exchange/types';
import { buildFixtureFromExchange, DROPPED_RESPONSE_HEADERS } from './domain/record/buildFixture';
import { FixtureStore } from './domain/record/fixtureStore';
import { SAMPLE_RULES_FILE } from './domain/rules/sample';
import { findUnreachableRules } from './domain/rules/unreachableRules';
import { isSetupTarget, SETUP_TARGETS } from './domain/setup/targets';
import type { SetupTarget } from './domain/setup/targets';
import { evaluateAssertions } from './domain/test/evaluate';
import { formatTestReport } from './domain/test/report';
import { hashDashboardPassword } from './infra/dashboard/dashboardPasswordHash';
import { startDashboardServer, WEB_DIST_DIR } from './infra/dashboard/dashboardServer';
import { DetourEventBus } from './infra/eventBus';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from './infra/fs/dumpFileWriter';
import { loadFixtureFiles, writeFixtureFile } from './infra/fs/fixtureFileSource';
import {
  findLiveRunState,
  isProcessAlive,
  removeRunState,
  reserveRunState,
  writeRunState,
} from './infra/fs/runStateStore';
import { fsRuleProfileStore } from './infra/fs/ruleProfileStore';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter, loadRulesFile } from './infra/fs/rulesFileSource';
import { loadTestFile } from './infra/fs/testFileSource';
import type { UserConfig } from './infra/fs/userConfigStore';
import { loadUserConfig, resolveUserConfigPath, writeUserConfig } from './infra/fs/userConfigStore';
import { buildGrpcExchangeInfo } from './infra/grpc/grpcExchangeInfo';
import { ProtoRegistry } from './infra/grpc/protoRegistry';
import { lanAddresses } from './infra/network/lanAddresses';
import { isHistoryPersistenceSupported, openHistoryStore, type HistoryStore } from './infra/persistence/historyStore';
import { isDaemonChild, signalDaemonError, signalDaemonReady, spawnDaemonChild } from './infra/process/daemonize';
import { nodeCommandRunner } from './infra/process/nodeCommandRunner';
import { openBrowser } from './infra/process/openBrowser';
import { caCertPath, ensureCaCert, readCaValidity, regenerateCaCert } from './infra/proxy/certExport';
import { startIdleWatcher } from './infra/proxy/idleWatcher';
import { nodeCertPairingServer } from './infra/proxy/nodeCertPairingServer';
import { readlineDevicePicker } from './infra/process/readlineDevicePicker';
import { startProxyServer } from './infra/proxy/proxyServer';
import { redactProxyUrlCredentials, validateUpstreamProxyUrl } from './infra/proxy/upstreamProxyAgent';
import {
  logExchange,
  logExchangeFull,
  logGrpcSection,
  logProxyError,
  logUnreachableRuleWarnings,
  logWebSocketConnection,
  logWebSocketFull,
} from './presentation/logger';
import { renderQrCode } from './presentation/qrCode';
import { RuleEngine } from './usecase/ruleEngine';
import { runTargets } from './usecase/setup/orchestrator';
import type { SetupMode, TargetReport } from './usecase/setup/orchestrator';
import type { SetupStep, StepStatus, TargetOutcome } from './usecase/setup/types';

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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Scoped to the *dashboard* only — the proxy itself always binds to every
 * network interface regardless of `--lan`/`lanAccess` (see `PROXY_HOST`'s
 * doc comment), since a proxy nobody else's device can reach isn't much of
 * a proxy. This warning exists because the dashboard is the one piece
 * `--lan` still actually gates: it's where decrypted HTTPS traffic and rule
 * edits live, with no login of its own.
 *
 * `web/src/features/settings-panel/ui/SettingsPanel.tsx`'s dashboard-side
 * warning says the same thing in its own words — that's a separate,
 * standalone-built package with no access to this constant, so it's worded
 * to match by hand instead. Update both together.
 */
const LAN_ACCESS_WARNING =
  'there is no authentication of any kind — anyone on your network can reach the dashboard, view decrypted HTTPS traffic through it, or edit rules';

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

/**
 * Trailing per-target line for `doctor` only, when its steps are all `✔`/`ℹ`
 * (no `failed` *or* `skipped`, so the summary doesn't compete with a
 * clearer problem — a `skipped` step, e.g. no booted iOS Simulator or an
 * explicit `--target` on the wrong host platform, means some checks never
 * ran at all, a different problem than "ran but can't be auto-verified"
 * that a plain manual-verification count would blur together) and at least
 * one is `ℹ` (`manual`) — `doctor`'s whole point is answering "is this
 * ready?", and a screen full of `✔` with one quiet `ℹ` mixed in (e.g.
 * android's cert-trust check, which needs root to verify over adb) reads as
 * "yes" at a glance even though that one thing was never actually
 * confirmed. Spelled out only for `doctor`: `setup`'s `manual` steps are
 * "go do this next", not "this wasn't checked", so they don't need the same
 * flagging.
 */
function doctorSummaryLine(outcome: TargetOutcome): string | undefined {
  const manualCount = outcome.steps.filter((s) => s.status === 'manual').length;
  if (manualCount === 0 || outcome.steps.some((s) => s.status === 'failed' || s.status === 'skipped')) {
    return undefined;
  }
  return manualCount === 1
    ? "  ℹ 1 check above needs manual verification — doctor can't confirm it automatically."
    : `  ℹ ${manualCount} checks above need manual verification — doctor can't confirm them automatically.`;
}

async function printTargetReports(mode: SetupMode, reports: TargetReport[]): Promise<void> {
  for (const { target, outcome } of reports) {
    console.log(`\n${target}:`);
    for (const step of outcome.steps) {
      if (!printedLive.has(step)) await printStep(step);
    }
    if (mode === 'doctor') {
      const summary = doctorSummaryLine(outcome);
      if (summary) console.log(summary);
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
/**
 * Prints `detour doctor`'s CA-expiry line, returning false only when the CA
 * has actually expired (an expiry that's merely close is a `⚠`, not a
 * failure — see `caValidityReport`). An unreadable/corrupt `ca.pem` is
 * reported as a failure too: `doctor`'s job is saying so, not guessing.
 */
function printCaValidityCheck(certPath: string): boolean {
  let report: ReturnType<typeof caValidityReport>;
  try {
    const validity = readCaValidity(certPath);
    if (!validity) return true; // Already reported as missing by the caller.
    report = caValidityReport(validity);
  } catch (err) {
    console.log(`✖ Could not read the CA certificate at ${certPath}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  // Same three icons the per-target steps use (see `stepIcon`), mapped from
  // the domain's severity so this line reads as one more check in the list.
  const icons: Record<CaValidityReport['severity'], string> = { ok: '✔', warning: '⚠', error: '✖' };
  console.log(`${icons[report.severity]} ${report.message}`);
  return report.severity !== 'error';
}

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

    // Nothing downstream can work once the root has lapsed, however well
    // every target is configured — so `doctor` reports on it alongside the
    // trust checks it already does (issue #164).
    const caExpired = mode === 'doctor' && !certMissing && !printCaValidityCheck(certPath);

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
    if (hasFailedStep(reports) || caExpired || (mode === 'doctor' && certMissing)) process.exitCode = 1;
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
  /** `--allow-external-script-paths` (issue #98): let `script.path`/`mock.bodyFile` resolve outside rules.json's own directory instead of being rejected — see `resolveRulePath`'s doc comment. Off by default. */
  allowExternalScriptPaths?: boolean;
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
  /** `--lan`/`--no-lan`: bind the *dashboard* to every network interface (`0.0.0.0`) instead of just `localhost`, for this invocation — the proxy always binds to every interface regardless (see `PROXY_HOST`'s doc comment). Undefined when neither flag is passed — `resolveDashboardHost` then falls back to `~/.detour/config.json`'s `lanAccess`. Security-sensitive: see `UserConfigState.lanAccess`'s doc comment. */
  lan?: boolean;
  /**
   * `--persist [path]` (issue #144): opt-in SQLite persistence of every
   * finished exchange, queryable from the dashboard's History feature
   * beyond the live in-memory backlog's item-count/body-size caps (neither
   * of which this changes — see `HistoryStore`'s own doc comment).
   * `true` when the flag is passed with no path (commander's optional-
   * option-argument convention) — defaults to `~/.detour/history.db` in
   * that case; `undefined` when the flag isn't passed at all.
   */
  persist?: string | true;
  /**
   * `--upstream-proxy <url>` (issue #145): routes every proxy→upstream
   * connection through this HTTP(S)/SOCKS proxy instead of connecting to
   * the real destination directly — e.g. a corporate network reachable
   * only via an existing egress proxy. See `upstreamProxyAgent.ts`'s own
   * doc comment for the supported URL schemes.
   */
  upstreamProxy?: string;
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
 * The proxy's own bind address — always every network interface, unlike the
 * dashboard's (`resolveDashboardHost`). A proxy no other device on the
 * network can reach defeats its main use case (an Android/iOS device — or
 * anything else — pointing its own proxy setting at this machine), and
 * unlike the dashboard it has no rule-editing/traffic-viewing surface of
 * its own to expose: reaching it at all still requires a client to already
 * have this machine's CA cert (issued by `detour setup`) installed and
 * trusted, and to know to point its proxy setting here in the first place.
 * `--lan`/`lanAccess` accordingly only ever gates the dashboard now — see
 * `resolveDashboardHost`'s doc comment.
 */
const PROXY_HOST = '0.0.0.0';

/**
 * Resolves the host the *dashboard* binds to for this `start` invocation:
 * `0.0.0.0` (every network interface) or `localhost`-only. Folds together
 * two sources, same priority as `resolveShouldDetach`'s `--detach`/
 * `--foreground`: an explicit `--lan`/`--no-lan` on the command line, then
 * `~/.detour/config.json`'s `lanAccess`, then `localhost`-only.
 *
 * Security-sensitive: LAN access has no authentication of its own, so
 * `0.0.0.0` means anything on the network can reach the dashboard and,
 * from there, decrypted HTTPS traffic and rule edits — see
 * `LAN_ACCESS_WARNING`. The proxy itself doesn't share this gate at all;
 * see `PROXY_HOST`'s doc comment for why.
 */
function resolveDashboardHost(options: StartOptions): string {
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
  // See installProcessCrashGuards's doc comment (issue #94): scoped to this
  // long-running path specifically, not every CLI command.
  installProcessCrashGuards();
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

  // Validated eagerly (same reasoning) so a malformed/unsupported
  // `--upstream-proxy` URL fails CLI startup with a clear error rather than
  // every proxied request thereafter silently failing to connect.
  if (options.upstreamProxy) validateUpstreamProxyUrl(options.upstreamProxy);

  // Opened eagerly (same reasoning as rules.json/`.proto` above) so a bad
  // `--persist` path (unwritable directory, an unsupported Node runtime)
  // fails CLI startup with a clear error rather than every exchange
  // thereafter silently going unpersisted.
  let historyStore: HistoryStore | undefined;
  let historyDbPath: string | undefined;
  if (options.persist) {
    if (!isHistoryPersistenceSupported()) {
      throw new Error('--persist requires Node 22.5+ (node:sqlite) — this runtime does not have it.');
    }
    historyDbPath = options.persist === true ? path.join(os.homedir(), '.detour', 'history.db') : options.persist;
    historyStore = openHistoryStore(historyDbPath);
  }

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
    // A write failure here (disk full, corrupt/locked DB) must not throw
    // out of this listener — it runs synchronously inside the proxy's own
    // 'response' emit, so an uncaught exception would crash the whole
    // running proxy and drop the live session over a feature that is only
    // supposed to be a side effect of it.
    try {
      historyStore?.record(exchange);
    } catch (err) {
      eventBus.emit('error', { errorKind: 'HISTORY_RECORD_ERROR', message: describeError(err) });
    }
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
  eventBus.on('rulesReloaded', ({ filePath, ruleCount, unreachableWarnings }) => {
    console.log(`↻ Reloaded rules (${ruleCount}): ${filePath}`);
    logUnreachableRuleWarnings(unreachableWarnings);
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
      allowExternalScriptPaths: options.allowExternalScriptPaths ?? false,
      onReload: (info) =>
        eventBus.emit('rulesReloaded', {
          filePath: ruleEngine!.filePath,
          ruleCount: info.ruleCount,
          unreachableWarnings: info.unreachableWarnings,
        }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
  }

  const dashboardHost = resolveDashboardHost(options);
  let handle: Awaited<ReturnType<typeof startProxyServer>>;
  try {
    handle = await startProxyServer(
      { port, host: PROXY_HOST, ruleEngine, http2Enabled: options.http2, upstreamProxyUrl: options.upstreamProxy },
      eventBus,
    );
  } catch (err) {
    // `historyStore` was opened above, before the proxy itself — a bind
    // failure here (e.g. the port's already in use) shouldn't leave its
    // SQLite file handle open (and, on some platforms, locked) for a
    // startup that's about to fail outright. Same shutdown-before-rethrow
    // shape as the dashboard bind/run-state-write failures below.
    historyStore?.close();
    throw err;
  }

  /**
   * Provisions a `RuleEngine` for a session that started with none — see
   * `DashboardServerOptions.createRuleEngine`'s own doc comment (issue
   * #123). Bootstraps `DEFAULT_RULES_FILENAME` with an empty ruleset so
   * `RuleEngine.load` (which reads its file eagerly) has something valid to
   * read *only if the file doesn't already exist* — `!rulesPath` above just
   * means this session's own startup didn't load one, not that nothing has
   * been written there since (by hand, or another process) with content
   * this shouldn't clobber. Whatever's already there, valid or not, is what
   * `RuleEngine.load` sees; a validation failure now surfaces as a normal
   * `RULE_PROFILE_ERROR` (see `ensureRuleEngine`'s own doc comment in
   * dashboardServer.ts) instead of being silently overwritten. Once loaded,
   * the caller's very next `RuleEngine.write()` (applying the profile that
   * triggered this in the first place) overwrites it with real content
   * regardless, so an empty ruleset bootstrapped here is never actually
   * visible to a client. Also wires the new engine into the already-running
   * proxy (see `ProxyServerHandle.setRuleEngine`'s own doc comment) —
   * without that, the dashboard would show a profile as "applied" while the
   * proxy quietly kept treating every request as ruleless passthrough.
   */
  function createDefaultRuleEngine(): RuleEngine {
    const filePath = path.resolve(process.cwd(), DEFAULT_RULES_FILENAME);
    // Tracked rather than assumed: the file may already exist (see the
    // `!fs.existsSync` guard just below, and its own doc comment above) if
    // something other than this session created it between startup and now
    // — the log message right after this shouldn't claim to have "created"
    // it when it actually just picked up what was already there.
    const bootstrapped = !fs.existsSync(filePath);
    if (bootstrapped) fsRulesFileWriter.write(filePath, { rules: [] });
    const engine = RuleEngine.load({
      filePath,
      reader: fsRulesFileReader,
      writer: fsRulesFileWriter,
      watcher: fsFileWatcher,
      allowExternalScriptPaths: options.allowExternalScriptPaths ?? false,
      onReload: (info) =>
        eventBus.emit('rulesReloaded', {
          filePath,
          ruleCount: info.ruleCount,
          unreachableWarnings: info.unreachableWarnings,
        }),
      onReloadError: (message) => eventBus.emit('error', { errorKind: 'RULES_RELOAD_ERROR', message }),
    });
    console.log(
      bootstrapped
        ? `ℹ Created ${DEFAULT_RULES_FILENAME} to apply this rule profile (auto-loaded from now on; pass --rules to use a different file)`
        : `ℹ Loaded existing ${DEFAULT_RULES_FILENAME} to apply this rule profile (auto-loaded from now on; pass --rules to use a different file)`,
    );
    logUnreachableRuleWarnings(engine.getUnreachableWarnings());
    handle.setRuleEngine(engine);
    return engine;
  }

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
          host: dashboardHost,
          proxyPort: handle.port,
          ruleEngine,
          ruleProfileStore: fsRuleProfileStore,
          // Lets the dashboard provision a `RuleEngine` itself the first time
          // one's actually needed (issue #123: applying a just-created Rule
          // Profile from a session that started with no rules file at all —
          // `ruleEngine` above is `undefined` in exactly that case). Omitted
          // when one already exists; see `DashboardServerOptions.createRuleEngine`'s
          // own doc comment for why only that one case needs this.
          createRuleEngine: ruleEngine ? undefined : () => createDefaultRuleEngine(),
          protoRegistry,
          historyStore,
          // Passed regardless of `dashboardHost` — the proxy this dashboard
          // fronts always binds to every interface, so its LAN address(es)
          // are always worth knowing. See `DashboardServerOptions.lanAddresses`'s
          // doc comment (issue #66).
          lanAddresses: lanAddresses(),
        },
        eventBus,
      );
    } catch (err) {
      // The proxy is already up and intercepting traffic at this point — don't
      // leave it running (and the process alive) just because the dashboard
      // failed to bind its port.
      historyStore?.close();
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
      historyStore?.close();
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
    dashboardHost,
    proxyPort: handle.port,
    caCertPath: handle.caCertPath,
    dashboardPort: dashboardHandle?.port,
    ruleEngine,
    dumpDir,
    http2Enabled: options.http2,
    protoPaths: options.proto,
    dashboardPasswordSet: readDashboardPasswordSet(),
    historyDbPath,
    upstreamProxyUrl: options.upstreamProxy,
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
    } finally {
      historyStore?.close();
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

/**
 * Whether a dashboard password is currently configured, for the startup
 * banner. `loadUserConfig()` can throw (invalid JSON, a failed validation) —
 * unlike a `detour config`/Settings-panel write, which the caller is
 * actively trying to make and should hear about if it fails, this only
 * exists to print an FYI line, so a broken config shouldn't crash `detour
 * start` over it. Same "fall back rather than propagate" posture as
 * `dashboardServer.ts`'s `userConfigMessage`.
 */
function readDashboardPasswordSet(): boolean {
  try {
    return !!loadUserConfig().dashboardPasswordHash;
  } catch {
    return false;
  }
}

/**
 * The startup banner's CA-expiry warning, or undefined when there's nothing
 * to warn about. Reading `ca.pem` can fail (deleted between startup and
 * banner, unreadable, corrupt) — that's not worth crashing a proxy that's
 * already up and serving over, so it degrades to no warning, the same
 * posture as `readDashboardPasswordSet` above.
 */
function caExpiryWarningLine(certPath: string): string | undefined {
  try {
    const validity = readCaValidity(certPath);
    return validity && caExpiryWarning(validity);
  } catch {
    return undefined;
  }
}

function printStartupBanner(info: {
  /** The dashboard's own bind host (`localhost` or `0.0.0.0`) — the proxy's is always `PROXY_HOST` ('0.0.0.0'), not passed in since this function never needs to branch on it. */
  dashboardHost: string;
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
  /** `--persist`'s resolved SQLite path (issue #144), undefined when not given. */
  historyDbPath: string | undefined;
  /** `--upstream-proxy`'s URL (issue #145), undefined when not given. */
  upstreamProxyUrl: string | undefined;
}): void {
  console.log(
    `Detour proxy started → http://localhost:${info.proxyPort} (HTTP/2: ${info.http2Enabled ? 'on' : 'off'})`,
  );
  console.log(`Root CA certificate: ${info.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  // Only printed inside the last 30 days of the CA's life (issue #164) —
  // renewing means re-trusting it on every device, which is worth a heads-up
  // well before the day everything starts failing at once. An already-
  // expired CA never gets this far: `CertAuthority.load` refuses it, so
  // `detour start` fails before printing any banner at all.
  const caWarning = caExpiryWarningLine(info.caCertPath);
  if (caWarning) console.log(`⚠ ${caWarning}`);
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
  // The proxy (unlike the dashboard) always binds to every network
  // interface — see `PROXY_HOST`'s doc comment — so its LAN address is
  // always worth printing, `--lan`/`lanAccess` or not: `localhost` on a
  // *different* device resolves to that device, not this machine, so the
  // `localhost` URL printed above is useless to whoever's supposed to reach
  // the proxy from elsewhere on the network. The dashboard only joins this
  // list (and only then gets the SECURITY callout below) when it's
  // actually bound to every interface too.
  const dashboardOnLan = info.dashboardPort !== undefined && info.dashboardHost !== 'localhost';
  const addresses = lanAddresses();
  if (addresses.length > 0) {
    console.log('Reachable on your network at:');
    for (const address of addresses) {
      console.log(`  Proxy     → http://${address}:${info.proxyPort}`);
      if (dashboardOnLan) console.log(`  Dashboard → http://${address}:${info.dashboardPort}`);
    }
  }
  if (dashboardOnLan) {
    // `--lan`/`detour config --lan on`: called out loudly rather than
    // folded quietly into the URL above — LAN access has no authentication
    // of its own, so anyone on the network can reach the dashboard and,
    // from there, decrypted HTTPS traffic and rule edits (the proxy itself
    // isn't part of this warning: it's always reachable this way, and has
    // no comparable rule-editing/traffic-viewing surface to expose — see
    // `LAN_ACCESS_WARNING`'s doc comment).
    console.log(
      `⚠ Dashboard bound to every network interface, not just this machine — SECURITY: ${LAN_ACCESS_WARNING}. Only do this on a network you trust.`,
    );
  }
  if (info.ruleEngine) {
    console.log(
      `Rules file: ${info.ruleEngine.filePath} (loaded ${info.ruleEngine.getRules().length} rule(s), watching for changes)`,
    );
    logUnreachableRuleWarnings(info.ruleEngine.getUnreachableWarnings());
  }
  if (info.dumpDir) {
    console.log(`Full request/response dumps → ${info.dumpDir}`);
  }
  if (info.protoPaths.length > 0) {
    console.log(`gRPC message decoding: ${info.protoPaths.length} .proto file(s) loaded`);
  }
  if (info.historyDbPath) {
    console.log(`History persistence → ${info.historyDbPath}`);
  }
  if (info.upstreamProxyUrl) {
    console.log(`Upstream proxy → ${redactProxyUrlCredentials(info.upstreamProxyUrl)}`);
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

/**
 * Last-resort safety net (issue #94): `detour start` is meant to run for
 * hours/days as a MITM proxy, so a single request/connection tripping an
 * unexpected synchronous throw or rejected promise somewhere deep in the
 * stack (a malformed percent-encoded URL hitting `decodeURIComponent`
 * uncaught was the case that surfaced this — see `staticServer.ts`'s own
 * guard for the actual fix) should never take the whole process — and every
 * in-flight proxied connection along with it — down with it. Node's default
 * behavior for an *unhandled* `uncaughtException`/`unhandledRejection` is to
 * print a stack trace and exit; registering a listener here suppresses that
 * exit and just logs instead, trading "crash loudly" for "stay up and keep
 * proxying" — the right tradeoff for a long-running local dev tool, even
 * though Node's own docs caution that continuing after an uncaught exception
 * can leave the process in a somewhat inconsistent state. Deliberately not
 * relied on as the primary fix for any specific bug (that's what a real
 * try/catch at the actual throw site is for) — this only exists to keep one
 * unanticipated one from being fatal.
 *
 * Called only from the top of `runStart` — deliberately *not* installed
 * globally for every CLI command (a first version of this fix did, from
 * both real entry points unconditionally). Continuing after an uncaught
 * exception is explicitly unsafe per Node's own docs, which is an
 * acceptable tradeoff for a proxy that's meant to keep running no matter
 * what, but not for a short-lived command like `detour config`/`detour
 * init`/etc. — those are better served by Node's default "print and exit"
 * behavior, which surfaces the bug immediately rather than risking the
 * command silently doing something inconsistent before an unrelated later
 * step exits. `detour start --detach`'s daemon child re-invokes this same
 * `start` path in its own fresh process (see `runDetached`/
 * `spawnDaemonChild`), so it's covered too without needing its own call.
 *
 * Idempotent: a second call (e.g. a test exercising both this and some
 * other path that also happens to call it) is a no-op rather than piling on
 * a duplicate pair of listeners, which would log every crash twice and grow
 * `process`'s listener count without bound across repeated calls.
 */
let processCrashGuardsInstalled = false;
export function installProcessCrashGuards(): void {
  if (processCrashGuardsInstalled) return;
  processCrashGuardsInstalled = true;
  process.on('uncaughtException', crashGuardUncaughtExceptionListener);
  process.on('unhandledRejection', crashGuardUnhandledRejectionListener);
}

/** Test-only: undoes `installProcessCrashGuards` (removes its listeners and resets the idempotency guard) so a test can exercise it fresh, e.g. to check the exact listener it installs rather than relying on side effects from an earlier test's call. */
export function __uninstallProcessCrashGuardsForTests(): void {
  process.removeListener('uncaughtException', crashGuardUncaughtExceptionListener);
  process.removeListener('unhandledRejection', crashGuardUnhandledRejectionListener);
  processCrashGuardsInstalled = false;
}

function crashGuardUncaughtExceptionListener(err: unknown): void {
  console.error(
    `✖ Uncaught exception (continuing): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  // Keep the process alive (that's the whole point of this guard — see the
  // doc comment above), but still mark the eventual exit as a failure.
  // `runStart`'s own `shutdown()` explicitly calls `process.exit(0)` on a
  // normal SIGINT/SIGTERM/--exit-on-idle stop, which overrides this — so in
  // the common case this only actually surfaces if the process exits some
  // other way (e.g. every open handle happens to close and Node drains the
  // event loop on its own, without `shutdown()` ever running) rather than
  // silently reporting success.
  process.exitCode = 1;
}

function crashGuardUnhandledRejectionListener(reason: unknown): void {
  console.error(
    `✖ Unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  process.exitCode = 1;
}

/** Default value of `--assertions` (issue #148) — unlike `--rules`'s auto-detection (which silently no-ops if `DEFAULT_RULES_FILENAME` isn't present), this filename is always the effective default, and `runTestCommand` fails fast if it doesn't exist. */
const DEFAULT_TEST_ASSERTIONS_FILENAME = 'detour.test.json';

/** Caps `runTestCommand`'s in-memory exchange array — see its `eventBus.on('response', ...)` listener's doc comment. */
const MAX_CAPTURED_TEST_EXCHANGES = 10_000;

/** Loads a `RuleEngine` for `--rules` if given, shared by `runTestCommand` and `runRecordCommand` — neither watches for changes, since both are one-shot runs bounded by the command under test's own exit. */
function loadOptionalRuleEngine(
  rulesPath: string | undefined,
  allowExternalScriptPaths: boolean,
): RuleEngine | undefined {
  if (!rulesPath) return undefined;
  return RuleEngine.load({
    filePath: rulesPath,
    reader: fsRulesFileReader,
    allowExternalScriptPaths,
    watch: false,
  });
}

/** An event bus with `detour start`'s own proxy-error logging already wired in, shared by `runTestCommand` and `runRecordCommand` — without it, a proxy-level failure (a connect error, a broken tunnel) during the run would be silently dropped instead of explaining why a request never showed up as a captured exchange. */
function createEventBusWithErrorLogging(): DetourEventBus {
  const eventBus = new DetourEventBus();
  eventBus.on('error', logProxyError);
  return eventBus;
}

interface TestOptions {
  assertions: string;
  rules?: string;
  allowExternalScriptPaths?: boolean;
  port: string;
}

/**
 * Resolves what `NODE_EXTRA_CA_CERTS` should be for the command under test.
 * If the parent process (or its own environment) already has one set, that
 * bundle is trusted for a real reason — overwriting it with just detour's
 * own CA would silently drop that trust for the command's whole run. Node
 * only ever reads `NODE_EXTRA_CA_CERTS` as a single file, so the two are
 * concatenated into a fresh temp file instead of simply picking one; the
 * caller is responsible for deleting it (`cleanup`) once the command exits.
 */
function resolveCaCertsForCommand(caCertPath: string): { path: string; cleanup: () => void } {
  const existing = process.env.NODE_EXTRA_CA_CERTS;
  if (!existing) return { path: caCertPath, cleanup: () => {} };
  let existingContents: string;
  try {
    existingContents = fs.readFileSync(existing, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read the existing NODE_EXTRA_CA_CERTS bundle to merge it with detour's own CA: ${existing}\n  ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // `mkdtempSync` (not a predictable `<tmpdir>/detour-test-ca-<pid>-<ts>.pem`
  // path built by hand) gets a securely, atomically created, uniquely-named
  // directory from the OS — on a shared multi-user machine, a hand-built
  // path is guessable ahead of time, letting another user pre-create a
  // symlink there that a plain `writeFileSync` would happily follow.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-ca-'));
  const combinedPath = path.join(tmpDir, 'combined-ca.pem');
  // `wx`: fails instead of following a pre-existing path (symlink or
  // otherwise) at `combinedPath` — belt-and-suspenders alongside `mkdtemp`
  // already giving this directory a name nothing else could have guessed.
  fs.writeFileSync(combinedPath, `${existingContents}\n${fs.readFileSync(caCertPath, 'utf8')}`, { flag: 'wx' });
  return {
    path: combinedPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort — a leftover temp dir in the OS tmp dir is harmless.
      }
    },
  };
}

/** Runs `command` with the proxy env vars set, resolving with its exit code (or 1, if it was killed by a signal instead of exiting normally). */
function runCommandUnderProxy(command: string[], proxyUrl: string, caCertPath: string): Promise<number> {
  const [cmd, ...args] = command;
  const { path: nodeExtraCaCerts, cleanup } = resolveCaCertsForCommand(caCertPath);
  // Stripped, not just left alone: many CI/dev environments already set
  // NO_PROXY/no_proxy to something like "localhost,127.0.0.1" for their own
  // reasons, which — inherited unchanged here — would make a proxy-aware
  // HTTP client under test bypass detour entirely for exactly the hosts a
  // local test run is most likely to hit, silently capturing zero exchanges
  // rather than failing loudly.
  const envWithoutNoProxy = { ...process.env };
  delete envWithoutNoProxy.NO_PROXY;
  delete envWithoutNoProxy.no_proxy;
  return new Promise<number>((resolve, reject) => {
    // `spawn()` reports most failures (bad command, ENOENT) asynchronously
    // via the 'error' event below, but it can also throw synchronously for
    // a handful of argument-validation failures — a try/catch here is what
    // makes `cleanup()` (deleting the temp CA-bundle directory) run on that
    // path too, instead of only on the two async outcomes.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd!, args, {
        stdio: 'inherit',
        env: {
          ...envWithoutNoProxy,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          // Lets a Node-based command under test (npm test, playwright, …)
          // trust the MITM'd HTTPS connections without a manual `detour
          // cert export`/trust step of its own.
          NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
        },
      });
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
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
async function runTestCommand(command: string[], options: TestOptions): Promise<void> {
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

/** Default `--out` for `detour record`/positional dir shown in its help (issue #149). */
const DEFAULT_FIXTURES_DIR = './fixtures';

interface RecordOptions {
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
async function runRecordCommand(command: string[], options: RecordOptions): Promise<void> {
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
async function runServeCommand(dir: string, options: ServeOptions): Promise<void> {
  const fixturesDir = path.resolve(dir);
  const fixtures = loadFixtureFiles(fixturesDir);
  if (fixtures.length === 0) {
    console.error(`⚠ No fixtures found in ${fixturesDir} — every request will get a 404.`);
  }
  const store = new FixtureStore(fixtures);
  const port = parsePort(options.port, '--port');

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const requestPath = req.url ?? '/';
    const fixture = store.findFixture(method, requestPath);
    // Drains and discards any request body regardless of outcome below —
    // matching is method+path only (see `FixtureStore`'s doc comment), so
    // the body is never read, but leaving it unconsumed on a POST/PUT can
    // make the client see a connection reset instead of this response.
    req.resume();
    if (!fixture) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `No fixture recorded for ${method} ${requestPath}` }));
      return;
    }
    let body: Buffer | undefined;
    if (fixture.responseBody !== undefined) {
      const encoding = fixture.responseBodyEncoding === 'base64' ? 'base64' : 'utf8';
      body = Buffer.from(fixture.responseBody, encoding);
    }
    // Stripped again here, not just trusted from recording time: a
    // hand-edited fixture (or one written by something other than `detour
    // record`) could reintroduce a hop-by-hop header or a stale
    // content-length that would otherwise break the client or produce an
    // invalid response.
    // A null-prototype object, not `{}` — `fixture.responseHeaders` keys
    // come straight from a JSON file that could be hand-edited (or crafted),
    // and a `{}`'s inherited prototype means a key like `__proto__` would
    // pollute it instead of just being an inert, ordinary header name.
    const responseHeaders: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    for (const [key, value] of Object.entries(fixture.responseHeaders)) {
      if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
    }
    // Node's `writeHead` overload picks its meaning from the 2nd argument's
    // type — passing `undefined` there for a fixture with no statusMessage
    // would be read as "this is the headers argument", not "message
    // omitted", silently dropping the real headers object in the 3rd
    // position instead of using it.
    if (fixture.statusMessage) {
      res.writeHead(fixture.status, fixture.statusMessage, responseHeaders);
    } else {
      res.writeHead(fixture.status, responseHeaders);
    }
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (err: Error): void => reject(err);
    server.once('error', onStartupError);
    // The literal `'127.0.0.1'`, not the all-interfaces default a bare
    // `listen(port)` binds to (matching the rest of this codebase's
    // secure-by-default posture — the proxy/dashboard only bind everywhere
    // under an explicit `--lan`), and not the hostname `'localhost'`
    // either: this repo's own CI runner resolves `'localhost'` to the IPv6
    // loopback (`::1`), which broke a `127.0.0.1`-based client (this same
    // file's own e2e tests included) — the numeric address sidesteps that
    // resolution entirely, and a test's own HTTP client base URL commonly
    // hardcodes `127.0.0.1` for exactly this kind of ambiguity.
    server.listen(port, '127.0.0.1', () => {
      // Otherwise this startup-only listener stays attached forever and a
      // later runtime error (e.g. an unexpected socket failure) would call
      // `reject` on an already-settled promise — a silent no-op — instead
      // of being visible anywhere.
      server.removeListener('error', onStartupError);
      resolve();
    });
  });

  server.on('error', (err) => {
    console.error(`✖ detour serve error: ${describeError(err)}`);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  console.log(`DETOUR_SERVE_READY port=${actualPort} fixtures=${fixtures.length} dir=${fixturesDir}`);
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
      '--allow-external-script-paths',
      `Allow a rule's \`script.path\`/\`mock.bodyFile\` to resolve outside the directory rules.json lives in (including an absolute path) instead of being rejected (issue #98). SECURITY: a \`script\` module runs as arbitrary JavaScript with detour's own process permissions, and a \`mock.bodyFile\` returns any file it points to as a response body — off by default so a rules.json write from anything reaching the dashboard (e.g. \`setRules\`) can't read/execute outside its own directory.`,
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
      `Bind the dashboard to every network interface (0.0.0.0) instead of just this machine, for this invocation (the proxy always binds to every interface regardless of --lan — a proxy nothing else on the network can reach isn't much of a proxy). SECURITY: ${LAN_ACCESS_WARNING}. On by default if \`lanAccess\` is set via \`detour config\`.`,
    )
    .option(
      '--no-lan',
      'Force the dashboard to localhost-only for this invocation even if `lanAccess` is enabled via `detour config` — the opposite of --lan. Never affects the proxy, which always binds to every interface regardless.',
    )
    .option(
      '--persist [path]',
      "Persist every finished exchange to a SQLite database (opt-in; default off), queryable from the dashboard's History feature once it falls out of the live 500-item backlog — the backlog itself, and the 256KB per-body capture cap, are unchanged. Defaults to ~/.detour/history.db when passed with no path. Requires Node 22.5+ (node:sqlite).",
    )
    .option(
      '--upstream-proxy <url>',
      'Route every proxy→upstream connection through this HTTP(S)/SOCKS proxy instead of connecting to the real destination directly — for a network (e.g. a corporate egress) only reachable that way. Supports http://, https://, socks://, socks4://, socks4a://, socks5://, and socks5h:// (with optional user:pass@ auth embedded in the URL).',
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

  /**
   * Validates `detour config --dashboard-password <value>`: `"off"` clears
   * it (returned as `null`, matching `UserConfig.dashboardPasswordHash`'s
   * own "unset" value); anything else must be non-empty — an accidentally-
   * empty value (a script that forgot to interpolate one, say) would
   * otherwise silently set a real, trivially-guessable password while
   * still reporting `dashboardPassword = on`, which is worse than not
   * setting one at all. `dashboardServer.ts`'s `setDashboardPassword`
   * handler rejects the same thing for the Settings-panel/WebSocket path.
   */
  function parseDashboardPasswordFlag(value: string): string | null {
    if (value === 'off') return null;
    if (value === '') throw new Error('--dashboard-password must not be empty (pass "off" to remove it)');
    return value;
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
      `When "on", \`detour start\` binds the dashboard to every network interface (0.0.0.0) by default (the proxy always does, on or off) — override per-invocation with --lan/--no-lan. SECURITY: ${LAN_ACCESS_WARNING}.`,
    )
    .option(
      '--dashboard-password <value>',
      'Require this password before the dashboard will send any traffic, rules, or accept any control message over its WebSocket connection (issue #66). Pass "off" to remove it. Independent of --lan; takes effect for new connections immediately (no restart needed); stored hashed, never in plaintext.',
    )
    .action(async (options: { defaultDetach?: string; lan?: string; dashboardPassword?: string }) => {
      try {
        const patch: UserConfig = {};
        if (options.defaultDetach !== undefined)
          patch.defaultDetach = parseOnOff(options.defaultDetach, '--default-detach');
        if (options.lan !== undefined) patch.lanAccess = parseOnOff(options.lan, '--lan');
        if (options.dashboardPassword !== undefined) {
          const value = parseDashboardPasswordFlag(options.dashboardPassword);
          patch.dashboardPasswordHash = value === null ? null : await hashDashboardPassword(value);
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

  cert
    .command('regenerate')
    .description(
      'Replaces the local root CA with a freshly generated one, valid for 3 years (issue #164) — needed when the current CA has expired, since detour never silently re-signs it. Every device that trusted the old certificate must trust the new one (`detour setup`).',
    )
    .action(async () => {
      try {
        const certPath = await regenerateCaCert();
        console.log(`✔ Generated a new CA certificate at ${certPath}`);
        console.log(
          '  The previous CA is gone: re-install this one on every device/browser that was trusting it (`detour setup`), and restart any running `detour start`.',
        );
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

  const rules = program.command('rules').description('Manage rules.json (the declarative rule engine config)');

  rules
    .command('validate <path>')
    .description("Validates a rules file against the schema and Detour's semantic rules")
    .action((rulesPath: string) => {
      try {
        const { rules: loaded } = loadRulesFile(path.resolve(rulesPath));
        console.log(`✔ ${rulesPath} is valid (${loaded.length} rule(s))`);
        // Non-fatal: an unreachable rule is a real bug in the file, but not
        // a schema violation — doesn't affect this command's exit code.
        logUnreachableRuleWarnings(findUnreachableRules(loaded));
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
