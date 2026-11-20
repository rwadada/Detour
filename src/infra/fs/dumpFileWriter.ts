import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatExchangeDump, formatWebSocketDump } from '../../domain/dump/dumpPolicy';
import type { CapturedExchange, CapturedWebSocketConnection } from '../../domain/exchange/types';
import { formatGrpcSection, type GrpcExchangeInfo } from '../../domain/grpc/grpcDumpFormat';

const DUMP_DIR_MODE = 0o700;
const DUMP_FILE_MODE = 0o600;

/**
 * Directory `--dump file` writes one redacted dump file per exchange into
 * (`~/.detour/dumps`), mirroring `certStore.ts`'s `resolveCertDir`. Header
 * values are redacted but bodies are not, so the directory is owner-only
 * like the rest of `~/.detour` (issue #303), and an existing one left
 * world-readable by an older Detour is tightened.
 */
export function resolveDumpDir(dir: string = path.join(os.homedir(), '.detour', 'dumps')): string {
  fs.mkdirSync(dir, { recursive: true, mode: DUMP_DIR_MODE });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, DUMP_DIR_MODE);
    } catch (err) {
      // Owned by another user (an earlier `sudo detour start`): not ours to change, and startup shouldn't fail over it.
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  }
  return dir;
}

/**
 * Writes one dump file 0600. `mode` alone only applies when the file is
 * created, and a response overwrites its request's file (which an older
 * Detour may have left 0644) — so the mode is fixed on the open descriptor
 * after truncating and before any of the new content is written.
 */
function writeOwnerOnly(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, 'w', DUMP_FILE_MODE);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, DUMP_FILE_MODE);
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes `exchange`'s full dump (see `formatExchangeDump` — headers
 * redacted) to its own file under `dumpDir`, named after the exchange id
 * so a request and its eventual response overwrite the same file rather
 * than accumulating duplicates. When `grpcInfo` is given (issue #18), its
 * decoded messages are appended after the regular dump.
 */
export function writeExchangeDumpFile(
  exchange: Readonly<CapturedExchange>,
  dumpDir: string,
  grpcInfo?: GrpcExchangeInfo,
): void {
  const safeId = exchange.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const content = grpcInfo
    ? `${formatExchangeDump(exchange)}\n${formatGrpcSection(grpcInfo)}`
    : formatExchangeDump(exchange);
  writeOwnerOnly(path.join(dumpDir, `${safeId}.txt`), content);
}

/**
 * Writes `connection`'s full dump (see `formatWebSocketDump` — headers
 * redacted) to its own file under `dumpDir`, named after the connection id
 * with a `ws-` prefix so it can't collide with an HTTP exchange dump that
 * happens to share the same uuid space, and so the two are easy to tell
 * apart when browsing the directory.
 */
export function writeWebSocketDumpFile(connection: Readonly<CapturedWebSocketConnection>, dumpDir: string): void {
  const safeId = connection.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  writeOwnerOnly(path.join(dumpDir, `ws-${safeId}.txt`), formatWebSocketDump(connection));
}
