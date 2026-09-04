import path from 'node:path';
import { resolveCertDir } from '../certStore';
import { CertAuthority } from './engine/certAuthority';

/**
 * Where Detour writes the local root CA it auto-generates on first run (see
 * `certStore.ts`'s doc comment) — computed directly rather than requiring a
 * live `CertAuthority` instance, mirroring the fixed `certs/ca.pem` layout
 * `CertAuthority.load` always uses under `resolveCertDir()`.
 */
export function caCertPath(): string {
  return path.join(resolveCertDir(), 'certs', 'ca.pem');
}

/**
 * Ensures the CA cert exists on disk, generating it if this is genuinely
 * the first time Detour has run anywhere on this machine (`detour cert
 * export` shouldn't require `detour start` to have run first). Returns the
 * cert's path either way.
 */
export async function ensureCaCert(): Promise<string> {
  return CertAuthority.load(resolveCertDir()).getCACertPath();
}
