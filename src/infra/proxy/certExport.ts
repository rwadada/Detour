import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { type CaValidity, evaluateCaValidity } from '../../domain/cert/caValidity';
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
  return (await CertAuthority.load(resolveCertDir())).getCACertPath();
}

/**
 * The remaining lifetime of the CA already on disk, or undefined when there
 * isn't one yet (issue #164) — read straight off `ca.pem` rather than via
 * `CertAuthority.load`, so that asking the question never has the side
 * effect of generating a CA (`detour doctor`'s whole contract), and so an
 * *expired* one can still be reported on rather than inheriting `load`'s
 * refusal to hand one back at all.
 */
export function readCaValidity(certPath: string = caCertPath()): CaValidity | undefined {
  if (!fs.existsSync(certPath)) return undefined;
  const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
  return evaluateCaValidity(cert.validity.notAfter);
}

/**
 * Discards the CA on disk and issues a fresh one (`detour cert regenerate`,
 * issue #164) — the documented way out of an expired root, which `detour
 * start` refuses to run with and deliberately never re-signs on its own.
 *
 * Every device that trusted the old certificate has to trust the new one:
 * it's a different certificate with a different key. That's precisely why
 * this is an explicit command rather than something startup does quietly.
 */
export async function regenerateCaCert(): Promise<string> {
  const dir = resolveCertDir();
  for (const stale of [
    path.join(dir, 'certs', 'ca.pem'),
    path.join(dir, 'keys', 'ca.private.key'),
    path.join(dir, 'keys', 'ca.public.key'),
  ]) {
    fs.rmSync(stale, { force: true });
  }
  return (await CertAuthority.load(dir)).getCACertPath();
}
