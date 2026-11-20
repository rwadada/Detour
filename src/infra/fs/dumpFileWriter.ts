import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatExchangeDump, formatWebSocketDump } from '../../domain/dump/dumpPolicy';
import type { CapturedExchange, CapturedWebSocketConnection } from '../../domain/exchange/types';
import { formatGrpcSection, type GrpcExchangeInfo } from '../../domain/grpc/grpcDumpFormat';
import { OWNER_ONLY_DIR_MODE, tightenIfOwned, writeOwnerOnlyFile } from './ownerOnly';

/**
 * Directory `--dump file` writes one redacted dump file per exchange into
 * (`~/.detour/dumps`), mirroring `certStore.ts`'s `resolveCertDir`. Header
 * values are redacted but bodies are not, so the directory is owner-only
 * like the CA key directory (issue #303), and an existing one this user owns
 * that an older Detour left world-readable is tightened. Each dump is written
 * 0600 as a new file (see `writeOwnerOnlyFile`).
 */
export function resolveDumpDir(dir: string = path.join(os.homedir(), '.detour', 'dumps')): string {
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  tightenIfOwned(dir, 'directory');
  return dir;
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
  writeOwnerOnlyFile(path.join(dumpDir, `${safeId}.txt`), content);
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
  writeOwnerOnlyFile(path.join(dumpDir, `ws-${safeId}.txt`), formatWebSocketDump(connection));
}
