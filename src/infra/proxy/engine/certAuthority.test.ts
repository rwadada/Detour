import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CA_VALIDITY_MS } from '../../../domain/cert/caValidity';
import { LruMap } from '../../../domain/shared/lruMap';
import { CertAuthority } from './certAuthority';

/** Toggle from inside a test to make the next `generateKeyPair` call fail — see the mock below. */
const cryptoMockState = vi.hoisted(() => ({ failNextKeygen: false }));

// Only `generateKeyPair` is overridden, and only for one call at a time
// (`failNextKeygen` resets itself the moment it fires): every other test in
// this file still exercises real OpenSSL keygen, and `X509Certificate` above
// is imported straight from the real module, unaffected by this mock.
//
// certAuthority.ts calls `promisify(generateKeyPair)`, not the callback form
// directly — and Node's real `generateKeyPair` carries a custom
// `util.promisify.custom` implementation that resolves to the named
// `{ publicKey, privateKey }` object, not the generic promisify fallback's
// positional array. A plain replacement function without that same symbol
// would silently corrupt every (non-failing) keygen in this file too, so it
// has to be attached here explicitly.
vi.mock('node:crypto', async (importOriginal) => {
  const { promisify } = await import('node:util');
  const actual = await importOriginal<typeof import('node:crypto')>();
  const actualGenerateKeyPairAsync = promisify(actual.generateKeyPair);
  function generateKeyPair(...args: Parameters<typeof actual.generateKeyPair>): void {
    (actual.generateKeyPair as (...a: Parameters<typeof actual.generateKeyPair>) => void)(...args);
  }
  Object.defineProperty(generateKeyPair, promisify.custom, {
    value: async (...args: Parameters<typeof actualGenerateKeyPairAsync>) => {
      if (cryptoMockState.failNextKeygen) {
        cryptoMockState.failNextKeygen = false;
        throw new Error('simulated transient keygen failure');
      }
      return actualGenerateKeyPairAsync(...args);
    },
  });
  return { ...actual, generateKeyPair };
});

/** A CA that's ready to mint leaves — `load` deliberately stops short of generating the leaf keypair (see `CertAuthority.warmUp`). */
async function loadWarm(dir: string): Promise<CertAuthority> {
  const ca = await CertAuthority.load(dir);
  await ca.warmUp();
  return ca;
}

describe('CertAuthority', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-ca-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generates a CA and persists it under certs/keys on first load', async () => {
    const ca = await CertAuthority.load(dir);
    expect(fs.existsSync(path.join(dir, 'certs', 'ca.pem'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'ca.private.key'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keys', 'ca.public.key'))).toBe(true);
    expect(ca.getCACertPath()).toBe(path.join(dir, 'certs', 'ca.pem'));
    expect(fs.readFileSync(ca.getCACertPath(), 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('reuses the same CA (not a freshly generated one) across repeated loads', async () => {
    const first = await CertAuthority.load(dir);
    const firstPem = fs.readFileSync(first.getCACertPath(), 'utf8');
    const second = await CertAuthority.load(dir);
    expect(fs.readFileSync(second.getCACertPath(), 'utf8')).toBe(firstPem);
  });

  it('mints a leaf certificate for a host, signed by the CA', async () => {
    const ca = await loadWarm(dir);
    const context = ca.getSecureContext('example.com');
    expect(context.context).toBeDefined();
  });

  it('caches a leaf certificate: the same hostname reuses the same secure context', async () => {
    const ca = await loadWarm(dir);
    const a = ca.getSecureContext('example.com');
    const b = ca.getSecureContext('example.com');
    expect(a).toBe(b);
  });

  it("a leaf cert's issuer matches the CA's subject, and its SAN covers the requested hostname", async () => {
    const ca = await loadWarm(dir);
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

  it('an IP-address hostname gets an IP-type (not DNS-type) subjectAltName entry', async () => {
    const ca = await loadWarm(dir);
    ca.getSecureContext('127.0.0.1');
    const { cert: leafPem } = (
      ca as unknown as { getLeafPem(hostname: string): { key: string; cert: string } }
    ).getLeafPem('127.0.0.1');
    const leaf = forge.pki.certificateFromPem(leafPem);
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; ip?: string }> } | undefined;
    expect(san?.altNames[0]).toMatchObject({ type: 7, ip: '127.0.0.1' });
  });

  describe('getMultiHostKeyCert (issue #159)', () => {
    it('produces a usable key/cert PEM pair', async () => {
      const ca = await loadWarm(dir);
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- example LAN address fixture, not a real one.
      const { key, cert } = ca.getMultiHostKeyCert(['localhost', '127.0.0.1', '192.168.1.5']);
      expect(key).toContain('-----BEGIN');
      expect(cert).toContain('-----BEGIN CERTIFICATE-----');
    });

    it('is not cached — unlike getSecureContext, each call mints a fresh cert', async () => {
      const ca = await loadWarm(dir);
      const a = ca.getMultiHostKeyCert(['localhost']);
      const b = ca.getMultiHostKeyCert(['localhost']);
      expect(a.cert).not.toBe(b.cert);
    });

    it('tolerates a repeated hostname without minting a duplicate SAN entry for it', async () => {
      const ca = await loadWarm(dir);
      expect(() => ca.getMultiHostKeyCert(['localhost', 'localhost', '127.0.0.1'])).not.toThrow();
    });

    // Copilot review, PR #175: an empty SAN is presented as a "valid" cert
    // by this method's own contract but rejected by every real client
    // (browsers ignore commonName and require a matching SAN entry).
    it('falls back to a localhost SAN rather than minting an empty one for an empty hostname list', async () => {
      const ca = await loadWarm(dir);
      const { cert: leafPem } = ca.getMultiHostKeyCert([]);
      const leaf = forge.pki.certificateFromPem(leafPem);
      const san = leaf.getExtension('subjectAltName') as
        | { altNames: Array<{ type: number; value?: string }> }
        | undefined;
      expect(san?.altNames).toHaveLength(1);
      expect(san?.altNames[0]).toMatchObject({ type: 2, value: 'localhost' });
    });

    it("the leaf cert's SAN covers every hostname given, IP and DNS alike, in order", async () => {
      const ca = await loadWarm(dir);
      const { cert: leafPem } = (
        ca as unknown as { mintLeafPem(hosts: readonly string[], commonName: string): { key: string; cert: string } }
      )
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- example LAN address fixture, not a real one.
        .mintLeafPem(['localhost', '127.0.0.1', '192.168.1.5'], 'localhost');
      const leaf = forge.pki.certificateFromPem(leafPem);
      const san = leaf.getExtension('subjectAltName') as
        | { altNames: Array<{ type: number; value?: string; ip?: string }> }
        | undefined;
      expect(san?.altNames).toHaveLength(3);
      expect(san?.altNames[0]).toMatchObject({ type: 2, value: 'localhost' });
      expect(san?.altNames[1]).toMatchObject({ type: 7, ip: '127.0.0.1' });
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- example LAN address fixture, not a real one.
      expect(san?.altNames[2]).toMatchObject({ type: 7, ip: '192.168.1.5' });
    });

    it('is signed by the CA, verifiable via OpenSSL parsing, and its SAN is real', async () => {
      const ca = await loadWarm(dir);
      const caCertX509 = new X509Certificate(fs.readFileSync(ca.getCACertPath(), 'utf8'));
      const { cert: leafPem } = (
        ca as unknown as { mintLeafPem(hosts: readonly string[], commonName: string): { key: string; cert: string } }
      )
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- example LAN address fixture, not a real one.
        .mintLeafPem(['localhost', '192.168.1.5'], 'localhost');
      const leafX509 = new X509Certificate(leafPem);
      expect(leafX509.checkIssued(caCertX509)).toBe(true);
      expect(leafX509.verify(caCertX509.publicKey)).toBe(true);
      expect(leafX509.subjectAltName).toMatch(/DNS:\s*localhost\b/);
      expect(leafX509.subjectAltName).toMatch(/IP Address:\s*192\.168\.1\.5\b/);
    });
  });

  // Windows has no POSIX permission bits — `mode`/`chmodSync` are no-ops
  // there (see certAuthority.ts's comments), so these only mean anything on
  // POSIX platforms (issue #96).
  describe.skipIf(process.platform === 'win32')('file permissions (POSIX only)', () => {
    it('creates the CA private key 0600 (owner-only) and its directory 0700, on first generation', async () => {
      await CertAuthority.load(dir);
      const keysDirMode = fs.statSync(path.join(dir, 'keys')).mode & 0o777;
      const keyMode = fs.statSync(path.join(dir, 'keys', 'ca.private.key')).mode & 0o777;
      expect(keysDirMode).toBe(0o700);
      expect(keyMode).toBe(0o600);
    });

    it('creates certsDir 0700 too, even though ca.pem/ca.public.key themselves stay at the default (public) mode', async () => {
      await CertAuthority.load(dir);
      const certsDirMode = fs.statSync(path.join(dir, 'certs')).mode & 0o777;
      expect(certsDirMode).toBe(0o700);
    });

    it('tightens a pre-existing CA left with loose permissions (by a version predating issue #96) on the next load', async () => {
      await CertAuthority.load(dir);
      const keysDir = path.join(dir, 'keys');
      const keyPath = path.join(keysDir, 'ca.private.key');
      // Deliberately loosening permissions to simulate a CA generated by a
      // version predating issue #96's fix — not a real permission mistake.
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keysDir, 0o755);
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keyPath, 0o644);

      await CertAuthority.load(dir);

      expect(fs.statSync(keysDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    });

    it('tightens a pre-existing world-readable keys/ca.private.key it is about to regenerate into (ca.pem missing/corrupted state)', async () => {
      // A Copilot review follow-up on issue #96: `load()` takes the
      // *generation* branch (not the load-and-tighten branch above)
      // whenever ca.pem is missing, regardless of whether keys/ survived —
      // e.g. a corrupted/partial prior run, or someone deleting only
      // ca.pem. `mkdirSync`'s/`writeFileSync`'s `mode` option is a no-op on
      // a directory/file that already exists, so without an explicit
      // chmod beforehand, the freshly-generated key would be written into
      // (and inherit) the old, world-readable permissions.
      await CertAuthority.load(dir);
      const keysDir = path.join(dir, 'keys');
      const keyPath = path.join(keysDir, 'ca.private.key');
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keysDir, 0o755);
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable CA.
      fs.chmodSync(keyPath, 0o644);
      fs.rmSync(path.join(dir, 'certs', 'ca.pem'));

      await CertAuthority.load(dir);

      expect(fs.statSync(keysDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  });

  describe('leaf key generation (issue #164)', () => {
    it('load() alone does not mint a leaf keypair — `detour cert export` never pays for one', async () => {
      const ca = await CertAuthority.load(dir);
      expect(() => ca.getDefaultKeyCert()).toThrow(/warmUp/);
    });

    it('warmUp() is idempotent, and every host shares the one leaf keypair', async () => {
      const ca = await loadWarm(dir);
      await ca.warmUp();
      const internals = ca as unknown as { getLeafPem(hostname: string): { key: string; cert: string } };
      expect(internals.getLeafPem('a.example.com').key).toBe(internals.getLeafPem('b.example.com').key);
    });

    it('lets a later warmUp() call retry after a transient keygen failure, instead of re-awaiting the same rejection forever', async () => {
      const ca = await CertAuthority.load(dir);
      cryptoMockState.failNextKeygen = true;
      await expect(ca.warmUp()).rejects.toThrow('simulated transient keygen failure');
      // The transient condition has "cleared" (the mock only fails once) —
      // without the fix, this second call would just re-await the same
      // permanently-rejected promise instead of generating a fresh keypair.
      await expect(ca.warmUp()).resolves.toBeUndefined();
      expect(() => ca.getSecureContext('example.com')).not.toThrow();
    });

    it('bounds both per-host caches rather than growing one entry per hostname forever', async () => {
      const ca = await loadWarm(dir);
      const caches = ca as unknown as {
        leafPemCache: LruMap<string, { key: string; cert: string }>;
        contextCache: LruMap<string, unknown>;
      };
      expect(caches.leafPemCache.capacity).toBe(1000);
      expect(caches.contextCache.capacity).toBe(1000);

      // Eviction itself is exercised here at a capacity of 2 rather than the
      // real 1000: what's worth checking is that minting goes *through* the
      // LRU (so a long-running proxy sheds old hosts instead of holding a
      // native OpenSSL context per hostname it ever saw) — that it evicts
      // the least-recently-used key is `lruMap.test.ts`'s job, and signing
      // 1001 real certificates to re-prove it would take ~30s.
      caches.leafPemCache = new LruMap(2);
      caches.contextCache = new LruMap(2);
      ca.getSecureContext('a.example.com');
      ca.getSecureContext('b.example.com');
      ca.getSecureContext('c.example.com');
      expect(caches.contextCache.size).toBe(2);
      expect(caches.contextCache.keys()).toEqual(['b.example.com', 'c.example.com']);
      expect(caches.leafPemCache.size).toBe(2);
    });
  });

  describe('CA validity (issue #164)', () => {
    it('issues a new CA valid for 3 years', async () => {
      const ca = await CertAuthority.load(dir);
      const cert = forge.pki.certificateFromPem(fs.readFileSync(ca.getCACertPath(), 'utf8'));
      const lifetime = cert.validity.notAfter.getTime() - Date.now();
      // A day of slack either way: notBefore is backdated a day and the
      // clock moves while the test runs.
      expect(lifetime).toBeGreaterThan(CA_VALIDITY_MS - 24 * 60 * 60 * 1000);
      expect(lifetime).toBeLessThanOrEqual(CA_VALIDITY_MS);
      expect(ca.getValidity().status).toBe('valid');
    });

    it('loads a CA from an older Detour untouched, rather than forcing a re-trust', async () => {
      // A 1-year, node-forge-generated CA is exactly what every version
      // before this one wrote — the whole point is that it keeps working,
      // since replacing it would mean re-installing the root on every
      // device the user has already set up.
      const legacyPem = writeLegacyCa(dir, new Date(Date.now() + 200 * 24 * 60 * 60 * 1000));
      const ca = await loadWarm(dir);
      expect(fs.readFileSync(ca.getCACertPath(), 'utf8')).toBe(legacyPem);
      expect(ca.getValidity().status).toBe('valid');
      // And it can still sign: the leaf keypair's new provenance
      // (node:crypto rather than node-forge) doesn't change what the old CA
      // key can put a signature on.
      const leafX509 = new X509Certificate(ca.getDefaultKeyCert().cert);
      expect(leafX509.checkIssued(new X509Certificate(legacyPem))).toBe(true);
    });

    it('refuses to load an expired CA, naming the command that replaces it', async () => {
      writeLegacyCa(dir, new Date(Date.now() - 24 * 60 * 60 * 1000));
      await expect(CertAuthority.load(dir)).rejects.toThrow(/expired/);
      await expect(CertAuthority.load(dir)).rejects.toThrow(/detour cert regenerate/);
    });

    it('still loads a CA that is close to expiring (the banner warns; startup does not fail)', async () => {
      writeLegacyCa(dir, new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
      const ca = await CertAuthority.load(dir);
      expect(ca.getValidity()).toMatchObject({ status: 'expiring-soon', daysRemaining: 5 });
    });
  });
});

/**
 * Writes a CA into `dir` the way every pre-issue-#164 Detour did: node-forge
 * key generation, node-forge PEM encoding, an explicit `notAfter`. Returns
 * the CA cert's PEM.
 *
 * 1024-bit deliberately — nothing here validates the key size, and this runs
 * in node-forge's pure-JS (synchronous) generator, which is exactly what
 * makes 2048 slow enough to be worth avoiding in a test fixture.
 */
function writeLegacyCa(dir: string, notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: 'commonName', value: 'Detour Local CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const pem = forge.pki.certificateToPem(cert);
  fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'certs', 'ca.pem'), pem);
  fs.writeFileSync(path.join(dir, 'keys', 'ca.private.key'), forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(path.join(dir, 'keys', 'ca.public.key'), forge.pki.publicKeyToPem(keys.publicKey));
  return pem;
}
