import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUpstreamTlsOptions } from './upstreamTlsOptions';

describe('resolveUpstreamTlsOptions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-upstream-tls-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('returns undefined when none of the flags were passed', () => {
    expect(resolveUpstreamTlsOptions({ upstreamCaPaths: [] })).toBeUndefined();
  });

  it('reads and returns --upstream-ca file contents, one entry per repeated flag, appended after the default trust store', () => {
    const ca1 = writeFile('ca1.pem', '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n');
    const ca2 = writeFile('ca2.pem', '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n');
    const options = resolveUpstreamTlsOptions({ upstreamCaPaths: [ca1, ca2] });
    expect(options?.ca).toEqual([...tls.rootCertificates, fs.readFileSync(ca1, 'utf8'), fs.readFileSync(ca2, 'utf8')]);
  });

  it('extends the default trust store rather than replacing it, so other publicly-trusted hosts stay reachable', () => {
    // Node's `ca` option *replaces* its default trusted roots when given —
    // regressing to `options.ca = flags.upstreamCaPaths.map(...)` (with no
    // `tls.rootCertificates` spread) would pass this if `ca` were merely
    // non-empty, so assert every default root is actually present too.
    const ca = writeFile('ca.pem', '-----BEGIN CERTIFICATE-----\nCCC\n-----END CERTIFICATE-----\n');
    const options = resolveUpstreamTlsOptions({ upstreamCaPaths: [ca] });
    for (const root of tls.rootCertificates) expect(options?.ca).toContain(root);
  });

  it('throws a clear error naming --upstream-ca when the file cannot be read', () => {
    expect(() => resolveUpstreamTlsOptions({ upstreamCaPaths: [path.join(tmpDir, 'missing.pem')] })).toThrowError(
      /--upstream-ca: could not read/,
    );
  });

  it('sets rejectUnauthorized: false only when --insecure-upstream was passed', () => {
    expect(resolveUpstreamTlsOptions({ upstreamCaPaths: [], insecureUpstream: true })?.rejectUnauthorized).toBe(false);
    expect(resolveUpstreamTlsOptions({ upstreamCaPaths: [], insecureUpstream: false })).toBeUndefined();
  });

  it('reads --client-cert/--client-key together', () => {
    const cert = writeFile('client.crt', 'CERT-CONTENT');
    const key = writeFile('client.key', 'KEY-CONTENT');
    const options = resolveUpstreamTlsOptions({ upstreamCaPaths: [], clientCertPath: cert, clientKeyPath: key });
    expect(options?.cert).toBe('CERT-CONTENT');
    expect(options?.key).toBe('KEY-CONTENT');
  });

  it('rejects --client-cert without --client-key', () => {
    const cert = writeFile('client.crt', 'CERT-CONTENT');
    expect(() => resolveUpstreamTlsOptions({ upstreamCaPaths: [], clientCertPath: cert })).toThrowError(
      /--client-cert and --client-key must be given together/,
    );
  });

  it('rejects --client-key without --client-cert', () => {
    const key = writeFile('client.key', 'KEY-CONTENT');
    expect(() => resolveUpstreamTlsOptions({ upstreamCaPaths: [], clientKeyPath: key })).toThrowError(
      /--client-cert and --client-key must be given together/,
    );
  });

  it('throws a clear error naming --client-cert/--client-key when either file cannot be read', () => {
    const cert = writeFile('client.crt', 'CERT-CONTENT');
    expect(() =>
      resolveUpstreamTlsOptions({
        upstreamCaPaths: [],
        clientCertPath: cert,
        clientKeyPath: path.join(tmpDir, 'missing.key'),
      }),
    ).toThrowError(/--client-key: could not read/);
  });

  it('combines every flag into one options object', () => {
    const ca = writeFile('ca.pem', 'CA-CONTENT');
    const cert = writeFile('client.crt', 'CERT-CONTENT');
    const key = writeFile('client.key', 'KEY-CONTENT');
    const options = resolveUpstreamTlsOptions({
      upstreamCaPaths: [ca],
      insecureUpstream: true,
      clientCertPath: cert,
      clientKeyPath: key,
    });
    expect(options).toEqual({
      ca: [...tls.rootCertificates, 'CA-CONTENT'],
      rejectUnauthorized: false,
      cert: 'CERT-CONTENT',
      key: 'KEY-CONTENT',
    });
  });
});
