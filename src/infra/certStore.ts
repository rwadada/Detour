import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` only applies to directories it creates — an existing
  // `~/.detour`/`~/.detour/certs` left world-readable by a version predating
  // this fix is untouched by the call above, so re-assert the invariant
  // explicitly on every start to remediate it. No-op on Windows.
  if (process.platform !== 'win32') {
    fs.chmodSync(detourDir, 0o700);
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}
