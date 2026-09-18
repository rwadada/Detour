import os from 'node:os';
import type { ClientProcessInfo } from '../../domain/exchange/types';
import type { CommandRunner } from '../../usecase/ports/commandRunner';

/**
 * Whether identifying a captured exchange's local client process (issue
 * #147) is even possible on this host. Correlating a TCP connection's local
 * endpoint back to its owning process via `lsof` is a macOS technique
 * specifically — matches issue #147's own macOS-only scope, rather than
 * also trying to support Linux's differently-shaped `lsof` output (or the
 * `/proc/net/tcp` + `/proc/<pid>/fd` route that's more idiomatic there).
 */
export function isClientProcessLookupSupported(): boolean {
  return os.platform() === 'darwin';
}

interface LsofConnection {
  pid: number;
  command: string;
  localAddress: string;
  localPort: number;
}

/**
 * Parses `lsof -F pcn` field-mode output (see `ClientProcessDirectory`'s own
 * command line) into one entry per open TCP connection. Field mode is used
 * instead of `lsof`'s default column-aligned text specifically to avoid
 * guessing column widths/positions — a long command name (e.g. "Google
 * Chrome Helper") would otherwise shift later columns in a way plain
 * whitespace-splitting can't reliably undo. Each process record starts with
 * a `p<pid>` line, followed by a `c<command>` line, followed by one `n<name>`
 * line per open TCP connection matching this invocation's `-i`/`-s` filters
 * — `-n -P` (also passed below) keep `<name>` numeric (`ip:port->ip:port`)
 * rather than resolved to hostnames/service names, which is what makes
 * matching against `net.Socket.remoteAddress`/`remotePort` (also always
 * numeric) reliable. A line that doesn't fit this shape (a listening socket
 * with no `->`, a header, a blank line) is skipped rather than throwing —
 * this is a best-effort lookup, not a strict parser.
 */
export function parseLsofFieldOutput(output: string): LsofConnection[] {
  const connections: LsofConnection[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const letter = line[0];
    const value = line.slice(1);
    if (letter === 'p') {
      pid = Number(value);
      command = undefined;
      continue;
    }
    if (letter === 'c') {
      command = value;
      continue;
    }
    if (letter !== 'n' || pid === undefined || command === undefined || !Number.isInteger(pid)) continue;
    const endpoints = value.match(/^(.+)->(.+)$/);
    if (!endpoints) continue;
    const local = endpoints[1]!.match(/^(.+):(\d+)$/);
    if (!local) continue;
    connections.push({ pid, command, localAddress: local[1]!, localPort: Number(local[2]) });
  }
  return connections;
}

/** How often the background snapshot refreshes — bounds both the `lsof` overhead (one spawn per interval, not per request) and how stale a just-opened connection can appear before showing up. */
const REFRESH_INTERVAL_MS = 2000;

/**
 * Background-polled snapshot of established TCP connections, keyed for
 * `lookupClientProcess`'s synchronous lookups (issue #147). Deliberately not
 * "run `lsof` per request": every captured exchange building its own
 * `CapturedExchange` needs an answer before that exchange's *first*
 * `request`/`response` broadcast — which, for a fast path like Block Hosts
 * or a `mock` rule, can fire in the very same tick with no network
 * round-trip to "hide" an async subprocess spawn behind. An async
 * per-request lookup that resolves after that first broadcast would almost
 * always miss it entirely, since this event bus only ever sends full
 * snapshots at emit time — there's no separate "exchange updated" message
 * a late result could ride in on. Polling in the background instead makes
 * every lookup synchronous (reading whatever snapshot is already in hand)
 * at the one-time cost of a stale window bounded by `REFRESH_INTERVAL_MS`,
 * and caps `lsof` overhead to one spawn per interval regardless of traffic
 * volume rather than one per exchange.
 */
export class ClientProcessDirectory {
  private connections: LsofConnection[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly runner: CommandRunner) {}

  /** Idempotent — a second call while already running is a no-op. Refreshes immediately (not just on the first interval tick) so an exchange captured right after startup still has a reasonable chance of a populated snapshot. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    // Never keeps the process alive on its own — this is a background
    // convenience, not something `detour start`'s own shutdown should have
    // to wait on if `stop()` is ever missed on some exit path.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refresh(): Promise<void> {
    try {
      const { stdout } = await this.runner.run('lsof', ['-n', '-P', '-iTCP', '-sTCP:ESTABLISHED', '-F', 'pcn']);
      this.connections = parseLsofFieldOutput(stdout);
    } catch {
      // `lsof` missing, denied (e.g. sandboxing), or erroring — leaves the
      // previous (possibly empty) snapshot in place rather than wiping out
      // an otherwise-still-useful cache over one transient failure. Every
      // failure mode here is a nice-to-have annotation quietly going stale,
      // never something that should affect capturing exchanges themselves.
    }
  }

  /**
   * Finds the process whose local address:port matches the given client
   * endpoint (a captured exchange's `req.socket.remoteAddress`/
   * `remotePort`) against the most recent background snapshot — up to
   * `REFRESH_INTERVAL_MS` stale, never awaiting a fresh `lsof` run. Only
   * ever finds a match when the client itself is a process on this same
   * machine (a local simulator/desktop app, not a physical device
   * elsewhere on the LAN), which is exactly the case issue #147 is about.
   */
  lookup(clientAddress: string, clientPort: number): ClientProcessInfo | undefined {
    const match = this.connections.find((c) => c.localAddress === clientAddress && c.localPort === clientPort);
    return match ? { pid: match.pid, name: match.command } : undefined;
  }
}
