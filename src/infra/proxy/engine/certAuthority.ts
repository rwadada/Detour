import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';

const { pki, md } = forge;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Subject fields for Detour's local root CA — cosmetic only, never checked by any test or client. */
const CA_ATTRS = [
  { name: 'commonName', value: 'Detour Local CA' },
  { name: 'organizationName', value: 'Detour' },
  { shortName: 'OU', value: 'Detour MITM Proxy' },
];

const LEAF_ATTRS = [{ name: 'organizationName', value: 'Detour' }];

function randomSerialNumber(): string {
  // DER requires a positive INTEGER whose leading byte has bit 7 clear (else
  // it reads as negative) *and* forbids any redundant leading 0x00 beyond
  // the one needed for that. Unconditionally prefixing "00" (as this used
  // to) satisfies the first rule but violates the second whenever the next
  // random byte also happens to land < 0x80 or, worse, is itself 0x00 (~1 in
  // 256): a double/redundant leading zero that strict ASN.1 parsers (real
  // TLS stacks, Node's own `X509Certificate`) reject as "illegal padding",
  // even though node-forge's own lenient parser accepts it (and then only
  // intermittently fails signature verification — this bit us as a ~1-in-500
  // flaky `certAuthority.test.ts` failure before the root cause was found).
  // Just clearing the first byte's top bit isn't quite enough either: that
  // byte can still land on exactly 0x00 (~1 in 128), which is once again a
  // redundant leading zero. Forcing it to a fixed non-zero value once
  // cleared guarantees a single canonical 16-byte positive INTEGER that is
  // never zero and never redundantly padded, matching forge's own original
  // CA generator's approach (this class replaced it — see the module
  // comment) more literally than a bare bitmask does.
  const raw = forge.random.getBytesSync(16);
  const firstByte = raw.charCodeAt(0) & 0x7f || 0x01;
  return forge.util.bytesToHex(String.fromCharCode(firstByte) + raw.slice(1));
}

/** IPv6 detection is deliberately loose (just "contains a colon") — good enough given `host` always arrives already bracket-stripped (see `ProxyEngine.parseHost`), so this only needs to not misclassify a plain hostname as an IP. */
function isIpAddress(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':');
}

/**
 * Detour's local MITM root CA, plus on-the-fly leaf certificates for each
 * host it intercepts — the node-forge-based replacement for what
 * `http-mitm-proxy`'s bundled `ca.ts` used to generate (issue #42).
 *
 * Keeps the same on-disk layout (`<dir>/certs/ca.pem`,
 * `<dir>/keys/ca.{private,public}.key`) so a CA already trusted by a user
 * upgrading from the old engine is loaded and reused as-is, rather than
 * forcing them to re-trust a freshly generated one.
 */
export class CertAuthority {
  private readonly certsDir: string;
  private readonly keysDir: string;
  private readonly caCert: forge.pki.Certificate;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  /** One RSA keypair, reused for every leaf cert — signing a new cert is cheap; generating a fresh 2048-bit key per host is not. Generated lazily (see `getLeafKeys`): a caller that only wants `getCACertPath()` (e.g. `detour cert export`) shouldn't pay for a keypair it never uses. */
  private leafKeys: forge.pki.rsa.KeyPair | undefined;
  private readonly leafPemCache = new Map<string, { key: string; cert: string }>();
  private readonly contextCache = new Map<string, tls.SecureContext>();

  private constructor(baseDir: string, caCert: forge.pki.Certificate, caKey: forge.pki.rsa.PrivateKey) {
    this.certsDir = path.join(baseDir, 'certs');
    this.keysDir = path.join(baseDir, 'keys');
    this.caCert = caCert;
    this.caKey = caKey;
  }

  /** Loads the CA from `dir` if one was already generated there, otherwise creates and persists a new one. */
  static load(dir: string): CertAuthority {
    const certsDir = path.join(dir, 'certs');
    const keysDir = path.join(dir, 'keys');
    const caCertPath = path.join(certsDir, 'ca.pem');

    if (fs.existsSync(caCertPath)) {
      const caCert = pki.certificateFromPem(fs.readFileSync(caCertPath, 'utf8'));
      const caKey = pki.privateKeyFromPem(fs.readFileSync(path.join(keysDir, 'ca.private.key'), 'utf8'));
      return new CertAuthority(dir, caCert, caKey);
    }

    fs.mkdirSync(certsDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
    const caKeys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = caKeys.publicKey;
    cert.serialNumber = randomSerialNumber();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + ONE_YEAR_MS);
    cert.setSubject(CA_ATTRS);
    cert.setIssuer(CA_ATTRS);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(caKeys.privateKey, md.sha256.create());

    fs.writeFileSync(path.join(certsDir, 'ca.pem'), pki.certificateToPem(cert));
    fs.writeFileSync(path.join(keysDir, 'ca.private.key'), pki.privateKeyToPem(caKeys.privateKey));
    fs.writeFileSync(path.join(keysDir, 'ca.public.key'), pki.publicKeyToPem(caKeys.publicKey));

    return new CertAuthority(dir, cert, caKeys.privateKey);
  }

  private getLeafKeys(): forge.pki.rsa.KeyPair {
    this.leafKeys ??= pki.rsa.generateKeyPair(2048);
    return this.leafKeys;
  }

  getCACertPath(): string {
    return path.join(this.certsDir, 'ca.pem');
  }

  /** Mints (and caches) a CA-signed leaf certificate for `hostname`, as a PEM `{key, cert}` pair. */
  private getLeafPem(hostname: string): { key: string; cert: string } {
    const cached = this.leafPemCache.get(hostname);
    if (cached) return cached;

    const leafKeys = this.getLeafKeys();
    const cert = pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = randomSerialNumber();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + ONE_YEAR_MS);
    cert.setSubject([{ name: 'commonName', value: hostname }, ...LEAF_ATTRS]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [isIpAddress(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname }],
      },
    ]);
    cert.sign(this.caKey, md.sha256.create());

    const pem = { key: pki.privateKeyToPem(leafKeys.privateKey), cert: pki.certificateToPem(cert) };
    this.leafPemCache.set(hostname, pem);
    return pem;
  }

  /** A `tls.SecureContext` presenting a CA-signed leaf cert for `hostname`, cached across calls (see `getLeafPem`). Used both as the internal TLS/HTTP2 server's default context and its `SNICallback` response. */
  getSecureContext(hostname: string): tls.SecureContext {
    const cached = this.contextCache.get(hostname);
    if (cached) return cached;
    const context = tls.createSecureContext(this.getLeafPem(hostname));
    this.contextCache.set(hostname, context);
    return context;
  }

  /** The leaf PEM pair used as the TLS server's static default (pre-SNI) `key`/`cert` options. */
  getDefaultKeyCert(): { key: string; cert: string } {
    return this.getLeafPem('localhost');
  }
}
