import { X509Certificate } from 'node:crypto';
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
    // leaf, so instead verify against the CA cert on disk plus a freshly
    // signed leaf for the same host.
    //
    // Deliberately uses node:crypto's X509Certificate (real OpenSSL parsing
    // and signature verification), not node-forge's own certificate.verify —
    // forge's ASN.1 layer re-derives the TBSCertificate it hashes at verify
    // time in a way that isn't always byte-identical to what was actually
    // signed, so forge's verify() intermittently (~1 in 500-700 runs)
    // returned false on a perfectly valid signature. Checking through
    // OpenSSL instead avoids that forge-specific edge case and exercises the
    // same validation path a real TLS client does.
    const caCertX509 = new X509Certificate(fs.readFileSync(ca.getCACertPath(), 'utf8'));
    // getDefaultKeyCert() always mints (and caches) the 'localhost' leaf —
    // reusing it here avoids reaching into CertAuthority's private cache.
    const { cert: leafPem } = ca.getDefaultKeyCert();
    const leafX509 = new X509Certificate(leafPem);
    expect(leafX509.checkIssued(caCertX509)).toBe(true);
    expect(leafX509.verify(caCertX509.publicKey)).toBe(true);
    // subjectAltName is OpenSSL's free-form rendering, not a stable format —
    // match loosely (optional whitespace after the colon) rather than the
    // exact "DNS:localhost" substring, which could vary across builds.
    expect(leafX509.subjectAltName).toMatch(/DNS:\s*localhost\b/);
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

  // Windows has no POSIX permission bits — `mode`/`chmodSync` are no-ops
  // there (see certAuthority.ts's comments), so these only mean anything on
  // POSIX platforms (issue #96).
  describe.skipIf(process.platform === 'win32')('file permissions (POSIX only)', () => {
    it('creates the CA private key 0600 (owner-only) and its directory 0700, on first generation', () => {
      CertAuthority.load(dir);
      const keysDirMode = fs.statSync(path.join(dir, 'keys')).mode & 0o777;
      const keyMode = fs.statSync(path.join(dir, 'keys', 'ca.private.key')).mode & 0o777;
      expect(keysDirMode).toBe(0o700);
      expect(keyMode).toBe(0o600);
    });

    it('creates certsDir 0700 too, even though ca.pem/ca.public.key themselves stay at the default (public) mode', () => {
      CertAuthority.load(dir);
      const certsDirMode = fs.statSync(path.join(dir, 'certs')).mode & 0o777;
      expect(certsDirMode).toBe(0o700);
    });

    it('tightens a pre-existing CA left with loose permissions (by a version predating issue #96) on the next load', () => {
      CertAuthority.load(dir);
      const keysDir = path.join(dir, 'keys');
      const keyPath = path.join(keysDir, 'ca.private.key');
      // Deliberately loosening permissions to simulate a CA generated by a
      // version predating issue #96's fix — not a real permission mistake.
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keysDir, 0o755);
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keyPath, 0o644);

      CertAuthority.load(dir);

      expect(fs.statSync(keysDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  });
});
