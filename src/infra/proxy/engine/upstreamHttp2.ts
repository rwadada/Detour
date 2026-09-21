import http from 'node:http';
import http2 from 'node:http2';
import tls from 'node:tls';
import { findHeader } from '../../../domain/exchange/headers';
import type { UpstreamCertificate } from '../../../domain/exchange/types';
import type { UpstreamTlsOptions } from '../upstreamTlsOptions';
import type { ProxyToServerRequestOptions } from './types';
import { captureUpstreamCertificate } from './upstreamCertificate';

/**
 * Idle timeout for a pooled h2 session, in ms — mirrors `ProxyEngine`'s own
 * `KEEP_ALIVE_AGENT_OPTIONS.timeout` for the HTTP/1.1 keep-alive pool
 * (issue #162), which this file can't import directly (`proxyEngine.ts`
 * already imports from here, and that constant isn't exported). Without
 * this, a session to a host that's gone quiet — the ordinary case once a
 * long-running Detour session moves on to debugging a different host —
 * would stay open forever: unlike `httpsAgent`, `UpstreamHttp2Pool` has no
 * `maxSockets`/`maxFreeSockets` cap either, so idle sessions are the only
 * thing bounding how many stay open across a session that's touched many
 * distinct hosts.
 */
const UPSTREAM_H2_IDLE_TIMEOUT_MS = 60_000;

/**
 * Connect/handshake timeout for the ALPN probe's own `tls.connect()`, in ms
 * — matches `KEEP_ALIVE_AGENT_OPTIONS.timeout` (the same value `httpAgent`/
 * `httpsAgent` give every socket they create) so this probe carries the same
 * backstop those agents already provide, rather than a new, weaker one.
 * Without this, an upstream that accepts the TCP connection but never
 * completes (or never finishes) the TLS handshake — a stalled load
 * balancer/firewall, or a server deliberately holding connections open —
 * would leave `probe()`'s promise pending forever: `secureConnect` and
 * `error` both never fire, so the exchange that triggered it (and, until it
 * settles, every concurrent request to the same host riding `pending`) hangs
 * with no timeout and no error surfaced.
 */
const UPSTREAM_PROBE_CONNECT_TIMEOUT_MS = 60_000;

/** Per-phase connect timing for a fresh probe — same shape as `ExchangeTiming`'s own dns/tcp/tls fields, kept separate so this module doesn't depend on the exchange-facing type. */
export interface ConnectTiming {
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
}

export interface AcquiredHttp2Session {
  protocol: 'HTTP/2';
  session: http2.ClientHttp2Session;
  /**
   * `false` only for the exchange whose request actually triggered this
   * session's ALPN probe; `true` for every one multiplexed onto it
   * afterward — mirrors `ExchangeTiming.connectionReused` (issue #162) so
   * the dashboard's Waterfall can tell "this session was just established"
   * apart from "this rode an existing one", the same distinction #162 drew
   * for the HTTP/1.1 keep-alive pool.
   */
  reused: boolean;
  timing: ConnectTiming;
  certificate?: UpstreamCertificate;
}

export interface AcquiredHttp1Fallback {
  protocol: 'HTTP/1.1';
  /**
   * Set only for the one request whose call to `acquire()` triggered this
   * host's ALPN probe — an already-`secureConnect`ed `TLSSocket`, handed
   * back so that request can use it directly (see `UpstreamHttp2Pool`'s own
   * doc comment for why probing for h2 must never cost an upstream that
   * turns out to be HTTP/1.1-only a second handshake). `undefined` for
   * every request after the first, once a host is already known to be
   * HTTP/1.1-only — those go through the ordinary pooled `httpsAgent`.
   */
  socket?: tls.TLSSocket;
  timing: ConnectTiming;
  certificate?: UpstreamCertificate;
}

export type AcquiredConnection = AcquiredHttp2Session | AcquiredHttp1Fallback;

type ProbeResult =
  | { kind: 'h2'; session: http2.ClientHttp2Session; timing: ConnectTiming; certificate?: UpstreamCertificate }
  | { kind: 'h1'; socket: tls.TLSSocket; timing: ConnectTiming; certificate?: UpstreamCertificate };

interface PendingProbe {
  promise: Promise<ProbeResult>;
  /** Flips to `true` once one caller has claimed the probe's fresh socket/timing — see `acquire`'s doc comment. */
  claimed: boolean;
}

/**
 * One h2 session (or "this host is HTTP/1.1-only") per upstream host:port,
 * for the proxy→upstream leg (issue #166). `https.Agent` gives no way to
 * learn what a connection's TLS handshake actually ALPN-negotiated, so
 * deciding whether a host speaks h2 means opening the TLS connection by
 * hand (`tls.connect`, offering `['h2', 'http/1.1']`) and reading
 * `socket.alpnProtocol` back — verified empirically (see this PR's repro
 * script) that handing an already-secured socket like that straight to
 * `http2.connect({ createConnection: () => socket })` works exactly as
 * Node's own docs imply, with no further handshake.
 *
 * The same probe socket is also the answer for the (overwhelmingly common)
 * case where a host turns out to be HTTP/1.1-only: rather than throw it away
 * and let the ordinary `httpsAgent` open a second, redundant connection for
 * the very request that triggered the probe, that one request reuses this
 * exact socket directly. Verified empirically that this requires routing
 * through a throwaway `http.Agent` (not `https.Agent`, and not
 * `agent: false` alone) with `createConnection` overridden to return it:
 * `https.request()` always wraps whatever socket it's given in its own
 * fresh `tls.connect()`, which — given a socket that's already past its
 * handshake — fails immediately ("self-signed certificate" against Node's
 * own bundled roots, regardless of what the real handshake already
 * verified). A plain `http.Agent` never wraps its socket in TLS at all, so
 * handing it one that's already secured just works: the HTTP/1.1 framing
 * goes straight over it. Every request after that first one — once the
 * host is cached as HTTP/1.1-only — is completely unaffected, using
 * `ProxyEngine`'s own pooled `httpsAgent` exactly as before this existed.
 * Net effect: probing for h2 costs nothing extra, ever — the probe *is*
 * the first real request's own connection, whichever protocol it turns out
 * to speak.
 *
 * Deliberately doesn't compose with `--upstream-proxy` (issue #145): that
 * would mean ALPN-probing over a CONNECT tunnel through the upstream proxy
 * rather than a direct connection, which is a larger change than this
 * issue's own acceptance criteria ask for — `ProxyEngine` never calls
 * `acquire()` at all once an upstream proxy is configured, so every request
 * in that mode stays on the HTTP/1.1 path exactly as before this existed.
 */
export class UpstreamHttp2Pool {
  private readonly sessions = new Map<
    string,
    { session: http2.ClientHttp2Session; certificate?: UpstreamCertificate }
  >();
  private readonly knownHttp1Hosts = new Set<string>();
  private readonly pending = new Map<string, PendingProbe>();
  /** Every probe's own `tls.connect()` socket, from creation until its probe settles (resolved or rejected) — so `closeAll()` can destroy one still mid-handshake instead of leaking it past proxy shutdown. */
  private readonly pendingSockets = new Set<tls.TLSSocket>();

  /**
   * Resolves how to reach `host:port` for one HTTPS request: an existing
   * (or freshly multiplexed) h2 session, or the HTTP/1.1 fallback — with a
   * fresh socket attached only for the one caller that actually triggered a
   * new probe. Concurrent calls for the same never-before-seen host all
   * await the same in-flight probe rather than each opening their own
   * (`pending`); `claimed` — checked and set synchronously inside each
   * awaiter's continuation, which Promise semantics guarantee run in
   * registration order for the same promise — picks exactly one of them to
   * receive the probe's own fresh socket/timing/certificate, so the same
   * socket is never handed to two different requests.
   */
  async acquire(host: string, port: number, tlsOptions: UpstreamTlsOptions | undefined): Promise<AcquiredConnection> {
    const key = `${host}:${port}`;

    const existingSession = this.sessions.get(key);
    if (existingSession && !existingSession.session.closed && !existingSession.session.destroyed) {
      return {
        protocol: 'HTTP/2',
        session: existingSession.session,
        reused: true,
        timing: {},
        certificate: existingSession.certificate,
      };
    }
    if (existingSession) this.sessions.delete(key); // dead session — fall through to a fresh probe below.

    if (this.knownHttp1Hosts.has(key)) {
      return { protocol: 'HTTP/1.1', timing: {} };
    }

    let probe = this.pending.get(key);
    if (!probe) {
      const promise = this.probe(host, port, tlsOptions);
      probe = { promise, claimed: false };
      this.pending.set(key, probe);
      promise.finally(() => {
        if (this.pending.get(key) === probe) this.pending.delete(key);
      });
    }

    const result = await probe.promise;
    const isFirstClaim = !probe.claimed;
    probe.claimed = true;

    if (result.kind === 'h2') {
      this.sessions.set(key, { session: result.session, certificate: result.certificate });
      return {
        protocol: 'HTTP/2',
        session: result.session,
        reused: !isFirstClaim,
        timing: isFirstClaim ? result.timing : {},
        certificate: result.certificate,
      };
    }

    this.knownHttp1Hosts.add(key);
    // `result.socket` is not destroyed here for a losing (`!isFirstClaim`)
    // caller: it's the exact same object the winning caller's own copy of
    // `result` points to, and `dispatchWithAcquiredConnection` unconditionally
    // hands it off to `dispatchHttp1Request`/`requestOverSecuredSocket` for
    // real use — destroying it here would race that legitimate use and abort
    // the winner's own request. Nothing is actually leaked: exactly one
    // caller ever receives a `socket` in its own returned `AcquiredConnection`
    // (below), and that request's own `http.Agent` (`keepAlive: false`)
    // closes it normally once the exchange finishes.
    return {
      protocol: 'HTTP/1.1',
      socket: isFirstClaim ? result.socket : undefined,
      timing: isFirstClaim ? result.timing : {},
      certificate: isFirstClaim ? result.certificate : undefined,
    };
  }

  private probe(host: string, port: number, tlsOptions: UpstreamTlsOptions | undefined): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let lookupAt: number | undefined;
      let connectedAt: number | undefined;

      const socket = tls.connect({
        host,
        port,
        servername: host,
        ALPNProtocols: ['h2', 'http/1.1'],
        // Spread, not individually-named `ca: tlsOptions?.ca, ...` fields:
        // an explicit `rejectUnauthorized: undefined` key (as opposed to
        // the key being absent entirely) defeats Node's own
        // `NODE_TLS_REJECT_UNAUTHORIZED` env-var fallback in `tls.connect`
        // — verified empirically (this broke every one of this file's own
        // e2e tests before the fix, all of which rely on that env var
        // rather than `--insecure-upstream` to trust their throwaway
        // self-signed upstream certs). Spreading `undefined` (`tlsOptions`
        // itself, when unset) is a no-op with no keys at all, exactly
        // matching the already-proven-working pattern in
        // `ProxyEngine.forwardRequest`'s own `...(isSSL ? this.upstreamTls
        // : undefined)`.
        ...tlsOptions,
      });
      this.pendingSockets.add(socket);
      socket.setTimeout(UPSTREAM_PROBE_CONNECT_TIMEOUT_MS, () => {
        socket.destroy(
          new Error(`upstream connection to ${host}:${port} timed out before completing its TLS handshake`),
        );
      });
      socket.once('lookup', () => {
        lookupAt = Date.now();
      });
      socket.once('connect', () => {
        connectedAt = Date.now();
      });
      socket.once('secureConnect', () => {
        // The probe's own connect/handshake backstop no longer applies once
        // secured — reuse for the h1 fallback request has its own throwaway
        // `http.Agent` (single request, no idling), and a fresh h2 session
        // gets its own idle timeout via `watchSession`.
        socket.setTimeout(0);
        this.pendingSockets.delete(socket);
        const securedAt = Date.now();
        const timing: ConnectTiming = {
          dnsMs: lookupAt !== undefined ? lookupAt - startedAt : undefined,
          tcpMs: connectedAt !== undefined ? connectedAt - (lookupAt ?? startedAt) : undefined,
          tlsMs: securedAt - (connectedAt ?? startedAt),
        };
        const certificate = captureUpstreamCertificate(socket);

        if (socket.alpnProtocol === 'h2') {
          const session = http2.connect(`https://${host}:${port}`, { createConnection: () => socket });
          this.watchSession(`${host}:${port}`, session);
          resolve({ kind: 'h2', session, timing, certificate });
        } else {
          resolve({ kind: 'h1', socket, timing, certificate });
        }
      });
      socket.once('error', (err) => {
        this.pendingSockets.delete(socket);
        reject(err);
      });
    });
  }

  /**
   * Evicts a session once it goes away, so the next `acquire()` for that
   * host re-probes instead of trying to multiplex onto a dead session
   * forever. Also the session's own `'error'` listener — without one, Node
   * treats an unhandled `'error'` on any EventEmitter as fatal — and its
   * idle-timeout: `UPSTREAM_H2_IDLE_TIMEOUT_MS` of no activity closes the
   * session itself, which then reaches this same `evict` via the `'close'`
   * listener just below (`session.close()` is a graceful GOAWAY, not an
   * abrupt `destroy()`, so any request that raced in just before the
   * timeout still gets to finish).
   */
  private watchSession(key: string, session: http2.ClientHttp2Session): void {
    const evict = () => {
      if (this.sessions.get(key)?.session === session) this.sessions.delete(key);
    };
    session.setTimeout(UPSTREAM_H2_IDLE_TIMEOUT_MS, () => session.close());
    session.once('close', evict);
    session.once('error', evict);
    session.once('goaway', evict);
  }

  /** Closes every live h2 session and any still-mid-handshake probe socket (`ProxyEngine.close`) so a proxy shutdown doesn't leave upstream connections dangling — without this, a probe still in flight when `detour stop` runs would keep its raw `tls.connect()` socket open indefinitely, potentially delaying process exit. */
  closeAll(): void {
    for (const { session } of this.sessions.values()) {
      if (!session.closed && !session.destroyed) session.close();
    }
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    this.sessions.clear();
    this.knownHttp1Hosts.clear();
  }
}

/**
 * Dispatches a request over an already-`secureConnect`ed socket via plain
 * HTTP/1.1 framing, with zero extra handshake — see `UpstreamHttp2Pool`'s
 * own doc comment for why this needs a throwaway `http.Agent` (not
 * `https.request`, and not `agent: false` alone): `https.request()` always
 * re-wraps whatever socket it's given in its own fresh TLS handshake, which
 * fails immediately against an already-secured one.
 */
export function requestOverSecuredSocket(
  opts: http.RequestOptions,
  socket: tls.TLSSocket,
  callback: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  return http.request({ ...opts, agent }, callback);
}

const H2_ILLEGAL_REQUEST_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host']);

/**
 * Builds an h2 `session.request()` headers object from the same
 * `ctx.proxyToServerRequestOptions` an HTTP/1.1 upstream request would use
 * (issue #166): connection-specific headers RFC 9113 §8.2.2 forbids are
 * dropped (`host` included — h2 has no `Host` header, only `:authority`,
 * and RFC 9113 §8.3.1 requires the two to agree if both were ever present,
 * so simplest — and what a real h2 client does — is to never send `Host`
 * at all), and the pseudo-headers are synthesized from the same
 * method/path/host/port a real upstream connection would otherwise use.
 * Covers both directions the issue's design calls out (h1→h2 and h2→h2):
 * an h2 *client*'s own pseudo-headers already went through this exact
 * filtering upstream, in `ProxyEngine.forwardRequest`, so by the time this
 * runs there's no difference between an originally-h1 and an
 * originally-h2 client request's `opts`.
 */
export function buildHttp2RequestHeaders(opts: ProxyToServerRequestOptions, isSSL: boolean): http2.OutgoingHttpHeaders {
  const headers: http2.OutgoingHttpHeaders = {};
  for (const key in opts.headers) {
    const lower = key.toLowerCase();
    if (H2_ILLEGAL_REQUEST_HEADERS.has(lower)) continue;
    // HTTP/2 field names must be lowercase (RFC 9113 §8.2) — normally
    // already true (Node lowercases every header name it parses off the
    // wire, on both the h1 and h2 client-facing paths), but a `rewrite`
    // rule's `headers` config, or a `script` rule's `beforeRequest` hook
    // (which can replace `opts.headers` outright), is hand-authored and can
    // carry the same header name in more than one casing — ordinary JS
    // object keys, so e.g. `x-debug-id` and `X-Debug-Id` both survive as
    // distinct properties on `opts.headers` even though they name the same
    // header. Lowercasing collapses them onto the same key here; merged
    // (comma-joined, the standard way a repeated header is interpreted —
    // RFC 9110 §5.3) rather than one silently overwriting the other by
    // object-key enumeration order.
    const value = opts.headers[key];
    const existing = headers[lower];
    headers[lower] = typeof existing === 'string' ? `${existing}, ${value}` : value;
  }
  headers[':method'] = opts.method;
  headers[':path'] = opts.path;
  headers[':scheme'] = isSSL ? 'https' : 'http';
  headers[':authority'] = buildAuthority(opts, isSSL);
  return headers;
}

function buildAuthority(opts: ProxyToServerRequestOptions, isSSL: boolean): string {
  // Case-insensitive, like `findHeader`'s every other caller: `opts.headers`
  // (a `rewrite` rule's `hostHeader` override always writes lowercase
  // `host`, but a `script` rule's `beforeRequest` hook can replace
  // `opts.headers` outright with any hand-authored casing — the same
  // "a script rule can carry any casing" fact `buildHttp2RequestHeaders`
  // already accounts for above) can carry the override under any casing.
  const explicitHost = findHeader(opts.headers, 'host');
  if (typeof explicitHost === 'string' && explicitHost) return explicitHost;
  const port = typeof opts.port === 'number' ? opts.port : Number(opts.port);
  const defaultPort = isSSL ? 443 : 80;
  // `opts.host` is already bracket-stripped by `ProxyEngine.parseHost` for an
  // IPv6 literal (e.g. `::1`), so re-bracket it here — RFC 3986 §3.2.2 /
  // RFC 9113 §8.3.1 require a bracketed IPv6 literal in `:authority`,
  // otherwise a trailing `:<port>` would be indistinguishable from more of
  // the address itself.
  const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return Number.isFinite(port) && port !== defaultPort ? `${host}:${port}` : host;
}

/**
 * Adapts an h2 `ClientHttp2Stream` (both readable — the response body — and
 * writable — the already-sent request) into the `UpstreamResponse` shape
 * the rest of the pipeline reads generically (`statusCode`/`statusMessage`/
 * `headers`, alongside the stream's own inherited `pause`/`resume`/
 * `on('data')`/`readableEnded`) — see `engine/types.ts`'s own doc comment.
 * `:status` is the only pseudo-header a response ever carries; every other
 * key is a real header, copied through as-is.
 */
export function adaptHttp2Response(
  stream: http2.ClientHttp2Stream,
  // Same shape as the `'response'` event's own listener signature (Node's
  // own http2 typings) — `:status` is typed as `number` there via the
  // separate `IncomingHttpStatusHeader`, not the general `string | string[]`
  // index signature every other header uses.
  responseHeaders: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader,
): http2.ClientHttp2Stream & { statusCode?: number; statusMessage?: string; headers: http.IncomingHttpHeaders } {
  const statusCode = responseHeaders[':status'] ?? 200;
  const headers: http.IncomingHttpHeaders = {};
  for (const key in responseHeaders) {
    if (key.startsWith(':')) continue;
    headers[key] = responseHeaders[key];
  }
  const adapted = stream as http2.ClientHttp2Stream & {
    statusCode?: number;
    statusMessage?: string;
    headers: http.IncomingHttpHeaders;
  };
  adapted.statusCode = statusCode;
  adapted.statusMessage = http.STATUS_CODES[statusCode] ?? '';
  adapted.headers = headers;
  return adapted;
}
