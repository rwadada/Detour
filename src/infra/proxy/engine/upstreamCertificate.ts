import type { PeerCertificate, TLSSocket } from 'node:tls';
import type { UpstreamCertificate } from '../../../domain/exchange/types';

/**
 * Flattens a `tls.PeerCertificate.subject`/`.issuer` object (e.g.
 * `{ C: 'US', O: 'Example', CN: 'example.com' }`) to a single
 * distinguished-name-style string, for display. Node types a repeated RDN
 * attribute (e.g. two `OU` values) as a string array rather than a string —
 * joined with ", " rather than letting `${value}` stringify it via
 * `Array.prototype.toString`'s bare comma join (no separating space, easy
 * to misread as one long value).
 */
export function formatDistinguishedName(name: PeerCertificate['subject'] | undefined): string {
  if (!name) return '';
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`)
    .join(', ');
}

/**
 * Reads the upstream server's real TLS certificate off a just-handshaked
 * socket (issue #160) — the one piece of the real connection a client can
 * never see for itself once Detour is MITM'ing it. `getPeerCertificate(true)`
 * (the `true` includes the full chain, not just the leaf, though only the
 * leaf's own fields are surfaced here) returns an empty object rather than
 * `null`/`undefined` when no certificate is available; `Object.keys` is how
 * Node's own docs say to detect that case. `socket.authorized`/
 * `authorizationError` reflect the real verification outcome regardless of
 * `rejectUnauthorized` — `authorized` is `false` whenever the chain didn't
 * actually validate, `--insecure-upstream` or not, since that setting only
 * controls whether the connection is *allowed to proceed* despite that.
 *
 * Shared by `ProxyEngine.trackSocketTiming` (the plain HTTP/1.1 keep-alive
 * path) and `UpstreamHttp2Pool`'s own ALPN probe (issue #166) — both hand a
 * secured `TLSSocket` off to this exact same logic rather than each
 * re-implementing it.
 */
export function captureUpstreamCertificate(socket: TLSSocket): UpstreamCertificate | undefined {
  const peer = socket.getPeerCertificate(true);
  if (!peer || Object.keys(peer).length === 0) return undefined;
  return {
    subject: formatDistinguishedName(peer.subject),
    issuer: formatDistinguishedName(peer.issuer),
    validFrom: peer.valid_from,
    validTo: peer.valid_to,
    subjectAltName: peer.subjectaltname,
    fingerprint256: peer.fingerprint256,
    authorized: socket.authorized,
    authorizationError: socket.authorized
      ? undefined
      : ((socket.authorizationError as unknown as Error | null)?.message ?? String(socket.authorizationError)),
  };
}
