import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Directory where Detour keeps its local MITM root CA and the
 * per-host leaf certificates generated on the fly (~/.detour/certs).
 *
 * http-mitm-proxy auto-generates the CA on first run inside this
 * directory (as `certs/ca.pem`) and reuses it on subsequent starts,
 * so the user only has to trust it once.
 */
export function resolveCertDir(): string {
  const dir = path.join(os.homedir(), '.detour', 'certs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
