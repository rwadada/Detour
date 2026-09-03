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
    await new Promise<void>((resolve, reject) => {
      try {
        proxy.listen({ port: 0, host: 'localhost', sslCaDir: resolveCertDir() }, () => resolve());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    proxy.close();
  }
  return certPath;
}
