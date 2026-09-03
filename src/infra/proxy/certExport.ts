import fs from 'node:fs';
import path from 'node:path';
import { Proxy } from 'http-mitm-proxy';
import { resolveCertDir } from '../certStore';

/**
 * Where http-mitm-proxy writes the local root CA it auto-generates on first
 * run (see `certStore.ts`'s doc comment) — computed directly rather than
 * requiring a live `Proxy` instance, mirroring the fixed `certs/ca.pem`
 * layout `ca.js`'s `CA.create` always uses under `sslCaDir`.
 */
export function caCertPath(): string {
  return path.join(resolveCertDir(), 'certs', 'ca.pem');
}

/** How long `ensureCaCert` waits for the throwaway `Proxy` to finish binding before giving up, rather than hanging forever if `listen()`'s callback never fires. */
const ENSURE_CA_TIMEOUT_MS = 20_000;

/**
 * Ensures the CA cert exists on disk, generating it if this is genuinely
 * the first time Detour has run anywhere on this machine (`detour cert
 * export` shouldn't require `detour start` to have run first) — by binding
 * a throwaway `Proxy` instance to an ephemeral port purely to trigger
 * http-mitm-proxy's own CA generation/loading, then immediately closing it
 * again. Returns the cert's path either way.
 */
export async function ensureCaCert(): Promise<string> {
  const certPath = caCertPath();
  if (!fs.existsSync(certPath)) {
    const proxy = new Proxy();
    try {
      await new Promise<void>((resolve, reject) => {
        // A safety net, not the expected path — `listen()`'s callback not
        // firing would otherwise hang this (and `detour cert export`)
        // forever instead of failing with a clear error.
        const timeout = setTimeout(
          () => reject(new Error(`timed out after ${ENSURE_CA_TIMEOUT_MS}ms generating the CA certificate`)),
          ENSURE_CA_TIMEOUT_MS,
        );
        timeout.unref();
        try {
          proxy.listen({ port: 0, host: 'localhost', sslCaDir: resolveCertDir() }, () => {
            clearTimeout(timeout);
            resolve();
          });
        } catch (err) {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } finally {
      // Best-effort: on the timeout/throw paths above, `listen()` may not
      // have gotten far enough to actually create its internal servers yet,
      // in which case `close()` itself throws — nothing more to clean up
      // either way, and that shouldn't mask the real error above it.
      try {
        proxy.close();
      } catch {
        // Nothing to close.
      }
    }
  }
  return certPath;
}
