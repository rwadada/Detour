import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { hashPassword } from '../domain/auth/passwordHash';
import { parseProxyAuthFlag, type ProxyAuthCredentials } from '../domain/auth/proxyAuth';
import { CliExitError } from '../domain/daemon/errors';
import { startDashboardServer, WEB_DIST_DIR } from '../infra/dashboard/dashboardServer';
import { DetourEventBus } from '../infra/eventBus';
import { resolveDumpDir, writeExchangeDumpFile, writeWebSocketDumpFile } from '../infra/fs/dumpFileWriter';
import { fsRuleProfileStore } from '../infra/fs/ruleProfileStore';
import { fsFileWatcher, fsRulesFileReader, fsRulesFileWriter } from '../infra/fs/rulesFileSource';
import { findLiveRunState, removeRunState, reserveRunState, writeRunState } from '../infra/fs/runStateStore';
import { loadUserConfig } from '../infra/fs/userConfigStore';
import { buildGrpcExchangeInfo } from '../infra/grpc/grpcExchangeInfo';
import { ProtoRegistry } from '../infra/grpc/protoRegistry';
import { lanAddresses } from '../infra/network/lanAddresses';
import { isHistoryPersistenceSupported, openHistoryStore, type HistoryStore } from '../infra/persistence/historyStore';
import { isDaemonChild, signalDaemonError, signalDaemonReady, spawnDaemonChild } from '../infra/process/daemonize';
import { openBrowser } from '../infra/process/openBrowser';
import { startIdleWatcher } from '../infra/proxy/idleWatcher';
import { startProxyServer } from '../infra/proxy/proxyServer';
import { redactProxyUrlCredentials, validateUpstreamProxyUrl } from '../infra/proxy/upstreamProxyAgent';
import { LAN_ACCESS_WARNING, printStartupBanner } from '../presentation/banner';
import {
  logExchange,
  logExchangeFull,
  logGrpcSection,
  logProxyError,
  logUnreachableRuleWarnings,
  logWebSocketConnection,
  logWebSocketFull,
} from '../presentation/logger';
import { RuleEngine } from '../usecase/ruleEngine';
import { collectProtoPath, describeError, parseDumpLevel, parseIdleMs, parsePort } from './optionParsers';

/** Auto-loaded when `--rules` isn't given and this file exists in the current directory. */
const DEFAULT_RULES_FILENAME = 'passthrough.rule.json';

/** Dashboard defaults to this many ports above the proxy (e.g. proxy 8080 → dashboard 9080) when `--dashboard-port` isn't given explicitly. */
const DEFAULT_DASHBOARD_PORT_OFFSET = 1000;

/** Where a `--detach` daemon's stdout/stderr are appended (~/.detour/logs/<port>.log — one file per tracked port, overwritten across restarts of the same port isn't attempted; it just keeps growing, same as the console output a foreground run would otherwise produce). Mirrors `certStore.ts`'s `resolveCertDir`/`dumpFileWriter.ts`'s `resolveDumpDir`/`runStateStore.ts`'s `resolveRunDir`. */
function resolveLogFilePath(port: number): string {
  const dir = path.join(os.homedir(), '.detour', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${port}.log`);
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
  /**
   * `--proxy-auth <user:pass>` (issue #158): require these credentials
   * (`Proxy-Authorization: Basic …`) from every client before the proxy
   * serves it, for this invocation. Undefined when the flag isn't passed —
   * `resolveProxyAuth` then falls back to `~/.detour/config.json`'s
   * `proxyAuth`, same shape as `--lan`/`lanAccess`.
   */
  proxyAuth?: string;
}

/**
 * Resolves the credentials the proxy will demand for this `start`
 * invocation: an explicit `--proxy-auth <user:pass>` (hashed here, so the
 * plaintext never outlives this call), else `~/.detour/config.json`'s
 * already-hashed `proxyAuth`, else none at all — the out-of-the-box default,
 * an open proxy (see `PROXY_OPEN_WARNING` in `presentation/banner.ts`).
 *
 * Note that passing credentials on the command line makes them visible to
 * anything that can read this machine's process list; `detour config
 * --proxy-auth` exists partly so a long-running session doesn't have to.
 */
async function resolveProxyAuth(options: StartOptions): Promise<ProxyAuthCredentials | undefined> {
  if (options.proxyAuth !== undefined) {
    const { username, password } = parseProxyAuthFlag(options.proxyAuth);
    return { username, passwordHash: await hashPassword(password) };
  }
  return loadUserConfig().proxyAuth ?? undefined;
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

  // Resolved (and validated) eagerly for the same reason: a malformed
  // `--proxy-auth` value should fail CLI startup loudly rather than start a
  // proxy nobody — including its owner — can authenticate against.
  const proxyAuth = await resolveProxyAuth(options);

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
      {
        port,
        host: PROXY_HOST,
        ruleEngine,
        http2Enabled: options.http2,
        upstreamProxyUrl: options.upstreamProxy,
        proxyAuth,
      },
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
    proxyAuthSet: proxyAuth !== undefined,
    historyDbPath,
    // Redacted here rather than inside the banner: credentials can be
    // embedded in the URL, and `presentation/` may not import the `infra/`
    // module that knows how to strip them (see `printStartupBanner`).
    upstreamProxyUrl: options.upstreamProxy ? redactProxyUrlCredentials(options.upstreamProxy) : undefined,
    dashboardBuilt: isDashboardBuilt(),
    lanAddresses: lanAddresses(),
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

/** Wires `detour start` into the CLI (issue #168's split of the former single-file composition root). */
export function registerStartCommand(program: Command): void {
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
    .option(
      '--proxy-auth <user:pass>',
      "Require these credentials (HTTP Basic, via Proxy-Authorization) from every client before the proxy will serve it — without them the proxy is open to anything on your network that points itself at it (issue #158). Checked on both CONNECT and plain HTTP, before Block Hosts/Focus/rules, with no exception for localhost. Overrides `proxyAuth` from `detour config` for this invocation; the password is never stored or logged in plaintext (note that the value itself is visible in this machine's process list — `detour config --proxy-auth` avoids that).",
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
}
