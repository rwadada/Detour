import fs from 'node:fs';

/**
 * Upstream TLS behavior for the `httpsAgent`(s) every proxy→upstream HTTPS
 * request goes through (issue #160): trusting an additional CA
 * (`--upstream-ca`), skipping verification entirely (`--insecure-upstream`),
 * and/or presenting a client certificate for mTLS (`--client-cert`/
 * `--client-key`). Resolved once at `detour start` time and baked into the
 * Agent's own constructor options rather than threaded per-request — none
 * of these is ever per-rule or per-request, so a single shared setting
 * already covers everything they're for.
 */
export interface UpstreamTlsOptions {
  /** Extra CA cert(s) to trust, alongside Node's own bundled root store — one PEM-file's contents per `--upstream-ca <path>` flag (repeatable). */
  ca?: string[];
  /** `--insecure-upstream`: `false` skips upstream certificate verification entirely. Omit (equivalent to `true`) for the default, safe behavior. */
  rejectUnauthorized?: boolean;
  /** `--client-cert <path>`'s PEM content (mTLS) — always paired with `key` below; `resolveUpstreamTlsOptions` rejects one without the other. */
  cert?: string;
  /** `--client-key <path>`'s PEM content (mTLS) — see `cert`. */
  key?: string;
}

/**
 * Reads a PEM file for `--upstream-ca`/`--client-cert`/`--client-key`
 * eagerly, at CLI startup — mirrors `upstreamProxyAgent.ts`'s
 * `validateUpstreamProxyUrl`: a missing/unreadable file fails startup with a
 * clear error naming the flag, instead of every subsequent HTTPS request
 * thereafter silently failing to connect (or, worse for `--insecure-upstream`-
 * adjacent flags, silently not applying at all).
 */
function readPemFile(filePath: string, flag: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`${flag}: could not read "${filePath}": ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/**
 * Builds `UpstreamTlsOptions` from `detour start`'s raw CLI flags, reading
 * and validating every file path eagerly (see `readPemFile`). Returns
 * `undefined` when none of the flags were passed at all, so a caller can
 * tell "nothing configured" apart from "configured with everything at its
 * default" without inspecting individual fields.
 */
export function resolveUpstreamTlsOptions(flags: {
  upstreamCaPaths: string[];
  insecureUpstream?: boolean;
  clientCertPath?: string;
  clientKeyPath?: string;
}): UpstreamTlsOptions | undefined {
  if (flags.upstreamCaPaths.length === 0 && !flags.insecureUpstream && !flags.clientCertPath && !flags.clientKeyPath) {
    return undefined;
  }
  if (!!flags.clientCertPath !== !!flags.clientKeyPath) {
    throw new Error(
      '--client-cert and --client-key must be given together (mTLS needs both the certificate and its private key).',
    );
  }
  const options: UpstreamTlsOptions = {};
  if (flags.upstreamCaPaths.length > 0) {
    options.ca = flags.upstreamCaPaths.map((path) => readPemFile(path, '--upstream-ca'));
  }
  if (flags.insecureUpstream) options.rejectUnauthorized = false;
  if (flags.clientCertPath && flags.clientKeyPath) {
    options.cert = readPemFile(flags.clientCertPath, '--client-cert');
    options.key = readPemFile(flags.clientKeyPath, '--client-key');
  }
  return options;
}
