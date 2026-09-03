/**
 * Persisted once a `detour start` process has successfully bound its
 * port(s), keyed by the `--port` value that was requested (see
 * `infra/fs/runStateStore.ts`) — the same value a later `detour status
 * --port <n>` / `detour stop --port <n>` will be looked up by. Powers
 * "Fail on Running" (issue #20), `detour status`, and `detour stop`.
 *
 * Deliberately excludes an ephemeral `--port 0` run: with no stable port to
 * key the file by, there'd be nothing later commands could address it with
 * (see `cli.ts`'s `--detach`/`--fail-on-running` port-0 guard).
 */
export interface RunState {
  /** PID of the process that bound the ports below — either the foreground `detour start` process, or the detached daemon child (see `infra/process/daemonize.ts`). */
  pid: number;
  /** The `--port` value this state file is keyed by (before ephemeral-port resolution — always equal to `proxyPort` unless a future version of this file format changes that). */
  requestedPort: number;
  /** Port the proxy actually bound to. */
  proxyPort: number;
  /** Port the dashboard actually bound to — absent when started with `--headless`. */
  dashboardPort?: number;
  /** Whether `--headless` (no dashboard) was passed. */
  headless: boolean;
  /** Whether this process is a detached daemon child (`--detach`), for `detour status`'s output. */
  detached: boolean;
  /** Epoch ms this process finished starting up (ports bound). */
  startedAt: number;
  /** Path to this daemon's log file — set only when `detached` is true. */
  logFile?: string;
}
