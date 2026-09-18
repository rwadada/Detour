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
 * Parses `lsof -F pcn` field-mode output (see `lookupClientProcess`'s own
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

/**
 * Identifies the local process that owns the client→proxy TCP connection at
 * `clientAddress:clientPort` (a captured exchange's
 * `req.socket.remoteAddress`/`remotePort`, as seen by the proxy — i.e. the
 * *client's* end of that socket) — issue #147. Only ever finds a match when
 * the client itself is a process on this same machine (a local
 * simulator/desktop app, not a physical device elsewhere on the LAN),
 * which is exactly the case this issue is about.
 *
 * Best-effort by design: `lsof` missing, denied (e.g. sandboxing), erroring,
 * or simply not finding a match (the connection already closed, a
 * non-local client) all resolve to `undefined` rather than rejecting —
 * this is a nice-to-have annotation on a capture, never something that
 * should affect capturing the exchange itself.
 */
export async function lookupClientProcess(
  runner: CommandRunner,
  clientAddress: string,
  clientPort: number,
): Promise<ClientProcessInfo | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await runner.run('lsof', ['-n', '-P', '-iTCP', '-sTCP:ESTABLISHED', '-F', 'pcn']));
  } catch {
    return undefined;
  }
  const match = parseLsofFieldOutput(stdout).find(
    (c) => c.localAddress === clientAddress && c.localPort === clientPort,
  );
  return match ? { pid: match.pid, name: match.command } : undefined;
}
