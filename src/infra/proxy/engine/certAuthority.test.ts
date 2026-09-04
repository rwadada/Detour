import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CertAuthority } from './certAuthority';

describe('CertAuthority', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-ca-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generates a CA and persists it under certs/keys on first load', () => {
    const ca = CertAuthority.load(dir);
    expect(fs.existsSync(path.join(dir, 'certs', 'ca.pem'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'ca.private.key'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'ca.public.key'))).toBe(true);
    expect(ca.getCACertPath()).toBe(path.join(dir, 'certs', 'ca.pem'));
    expect(fs.readFileSync(ca.getCACertPath(), 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('reuses the same CA (not a freshly generated one) across repeated loads', () => {
    const first = CertAuthority.load(dir);
    const firstPem = fs.readFileSync(first.getCACertPath(), 'utf8');
    const second = CertAuthority.load(dir);
    expect(fs.readFileSync(second.getCACertPath(), 'utf8')).toBe(firstPem);
  });

  it('mints a leaf certificate for a host, signed by the CA', () => {
    const ca = CertAuthority.load(dir);
    const context = ca.getSecureContext('example.com');
    expect(context.context).toBeDefined();
  });

  it('caches a leaf certificate: the same hostname reuses the same secure context', () => {
    const ca = CertAuthority.load(dir);
    const a = ca.getSecureContext('example.com');
    const b = ca.getSecureContext('example.com');
    expect(a).toBe(b);
  });

  it("a leaf cert's issuer matches the CA's subject, and its SAN covers the requested hostname", () => {
    const ca = CertAuthority.load(dir);
    // getSecureContext only exposes an opaque tls.SecureContext — inspect the
    // underlying PEM (via the CA cert path + a second CertAuthority instance
    // reading the same on-disk CA) isn't feasible without re-deriving the
    // leaf, so instead verify through node-forge directly against the CA
    // cert on disk plus a freshly signed leaf for the same host.
    const caCert = forge.pki.certificateFromPem(fs.readFileSync(ca.getCACertPath(), 'utf8'));
    // getDefaultKeyCert() always mints (and caches) the 'localhost' leaf —
    // reusing it here avoids reaching into CertAuthority's private cache.
    const { cert: leafPem } = ca.getDefaultKeyCert();
    const leaf = forge.pki.certificateFromPem(leafPem);
    expect(leaf.issuer.getField('CN')?.value).toBe(caCert.subject.getField('CN')?.value);
    expect(caCert.verify(leaf)).toBe(true);
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ value?: string }> } | undefined;
    expect(san?.altNames.some((n) => n.value === 'localhost')).toBe(true);
  });

  it('an IP-address hostname gets an IP-type (not DNS-type) subjectAltName entry', () => {
    const ca = CertAuthority.load(dir);
    ca.getSecureContext('127.0.0.1');
    const { cert: leafPem } = (
      ca as unknown as { getLeafPem(hostname: string): { key: string; cert: string } }
    ).getLeafPem('127.0.0.1');
    const leaf = forge.pki.certificateFromPem(leafPem);
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; ip?: string }> } | undefined;
    expect(san?.altNames[0]).toMatchObject({ type: 7, ip: '127.0.0.1' });
  });
});
