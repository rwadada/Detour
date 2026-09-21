/**
 * Node's TLS stack names a certificate-verification failure via `err.code`
 * (surfaced from OpenSSL's own X.509 verify-error names, plus a couple of
 * Node-specific ones like the hostname-mismatch case) — this maps the ones
 * worth explaining in plain language. Deliberately not exhaustive: an
 * unrecognized code falls back to the caller's own generic error message
 * rather than this guessing at wording for a failure mode it doesn't know.
 */
const TLS_VERIFICATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the certificate chain could not be verified up to a trusted root',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    'the issuing CA certificate is not trusted (self-signed, or signed by a private CA)',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the server presented a self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'a self-signed certificate was found in the chain',
  CERT_HAS_EXPIRED: 'the certificate has expired',
  CERT_NOT_YET_VALID: "the certificate's validity period hasn't started yet",
  ERR_TLS_CERT_ALTNAME_INVALID: "the certificate's hostname doesn't match the requested host",
  CERT_UNTRUSTED: 'the certificate is untrusted',
  CERT_REVOKED: 'the certificate has been revoked',
};

/**
 * Recognizes a Node TLS certificate-verification failure by its `err.code`
 * (issue #160) and returns a specific, actionable message instead of the
 * generic "PROXY_TO_SERVER_REQUEST_ERROR: <raw error>" a client would
 * otherwise see — the exact complaint the issue opened with: an HTTP
 * debugging proxy that can't tell its user *why* a request to a self-signed/
 * private-CA/expired upstream failed. Returns `undefined` for any other
 * error (a plain connection refused, DNS failure, etc.), which the caller
 * falls back to its own generic message for.
 */
export function describeUpstreamTlsError(err: NodeJS.ErrnoException | null | undefined): string | undefined {
  const code = err?.code;
  if (!code) return undefined;
  const detail = TLS_VERIFICATION_ERROR_MESSAGES[code];
  if (!detail) return undefined;
  return (
    `Upstream certificate verification failed: ${detail} (${code}). ` +
    'Trust it with --upstream-ca <path>, or bypass verification for this session with --insecure-upstream.'
  );
}
