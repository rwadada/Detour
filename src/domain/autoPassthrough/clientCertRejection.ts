/**
 * The TLS alerts (RFC 8446 §6.2) a client sends when it refuses the
 * certificate Detour presented for a MITM'd host. Each one means "I don't
 * accept this certificate": this client doesn't trust the Detour CA (an
 * Android 7+ app that doesn't opt in to user CAs, a client with its own trust
 * store) or it pins a different certificate. Nothing on the proxy side can
 * make such a client accept the MITM, so the useful thing left is to stop
 * MITM-ing that host.
 *
 * Matched on the alert number OpenSSL appends to the error message
 * (`… SSL alert number 46`) rather than on `err.code`, whose spelling
 * follows OpenSSL's reason strings and differs between versions
 * (`ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN` vs `…_TLS_ALERT_…`).
 *
 * A client that simply hangs up mid-handshake (Node's own `tls` does this
 * instead of sending an alert) is deliberately *not* treated as a refusal:
 * a network drop looks the same, and switching a host to passthrough on a
 * flaky connection would silently stop decrypting it for the session.
 */
const REJECTION_ALERTS: ReadonlyMap<number, string> = new Map([
  [42, 'bad certificate'],
  [43, 'unsupported certificate'],
  [44, 'certificate revoked'],
  [45, 'certificate expired'],
  [46, 'certificate unknown'],
  [48, 'unknown CA'],
]);

const ALERT_NUMBER = /SSL alert number (\d+)/;

/** The alert a client refused Detour's certificate with (`'certificate unknown'`, `'unknown CA'`, …), or `undefined` for any other TLS failure. */
export function clientCertRejectionAlert(error: { message?: unknown } | undefined): string | undefined {
  const message = error?.message;
  if (typeof message !== 'string') return undefined;
  const match = ALERT_NUMBER.exec(message);
  return match ? REJECTION_ALERTS.get(Number(match[1])) : undefined;
}

/**
 * Hosts whose clients refused Detour's certificate this session, and so are
 * relayed as raw TLS from then on instead of MITM'd (auto TLS passthrough).
 * Keyed by the TLS server name (SNI) the client asked for, lowercased, which
 * is what a CONNECT for the same host names too. Lives as long as the
 * process: restarting Detour (say, after installing the CA properly)
 * starts MITM-ing every host again.
 */
export interface AutoPassthroughHosts {
  /** Records `host`; `true` if it wasn't already recorded. */
  add(host: string): boolean;
  has(host: string): boolean;
}

export function createAutoPassthroughHosts(): AutoPassthroughHosts {
  const hosts = new Set<string>();
  return {
    add(host) {
      const key = host.toLowerCase();
      if (hosts.has(key)) return false;
      hosts.add(key);
      return true;
    },
    has: (host) => hosts.has(host.toLowerCase()),
  };
}
