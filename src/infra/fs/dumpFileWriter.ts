import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatExchangeDump } from '../../domain/dump/dumpPolicy';
import type { CapturedExchange } from '../../domain/exchange/types';
import { formatGrpcSection, type GrpcExchangeInfo } from '../../domain/grpc/grpcDumpFormat';

/**
 * Directory `--dump file` writes one redacted dump file per exchange into
 * (`~/.detour/dumps`), mirroring `certStore.ts`'s `resolveCertDir`.
 */
export function resolveDumpDir(): string {
  const dir = path.join(os.homedir(), '.detour', 'dumps');
  fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(path.join(dumpDir, `${safeId}.txt`), content, 'utf8');
}
