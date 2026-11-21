import os from 'node:os';
import path from 'node:path';
import { ensureOwnerOnlyDir } from './fs/ownerOnly';

/**
 * Directory where Detour keeps its local MITM root CA and the
 * per-host leaf certificates generated on the fly (~/.detour/certs).
 *
 * `CertAuthority` (engine/certAuthority.ts) auto-generates the CA on first
 * run inside this directory (as `certs/ca.pem`) and reuses it on subsequent
 * starts, so the user only has to trust it once.
 */
export function resolveCertDir(): string {
  const detourDir = path.join(os.homedir(), '.detour');
  const dir = path.join(detourDir, 'certs');
  // 0o700 (owner-only): this tree ends up holding the CA private key (see
  // `CertAuthority.load`, which creates `<dir>/keys/ca.private.key` inside
  // it) — issue #96. `recursive: true` applies `mode` to every directory
  // mkdirSync actually creates in the chain, so a first-ever run also locks
  // down `~/.detour` itself in this one call. Meaningless on Windows (no
  // POSIX permission bits), but harmless to still pass.
  // Both are tightened on every start, not just created 0700: a
  // `~/.detour`/`~/.detour/certs` left world-readable by a version predating
  // this fix is remediated too.
  ensureOwnerOnlyDir(detourDir);
  ensureOwnerOnlyDir(dir);
  return dir;
}
