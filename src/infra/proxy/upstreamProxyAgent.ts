import http from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const SOCKS_SCHEMES: ReadonlySet<string> = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const SUPPORTED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', ...SOCKS_SCHEMES]);

/**
 * Validates an `--upstream-proxy` URL (issue #145) eagerly, at CLI startup —
 * a clear error here beats every proxied request silently failing to
 * connect once `ProxyEngine` actually tries to use a malformed/unsupported
 * one. Returns the parsed URL for `createUpstreamProxyAgents` to reuse
 * rather than re-parsing.
 */
export function validateUpstreamProxyUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `redactProxyUrlCredentials` needs a URL that actually parses to find
    // the credentials to strip — this one, by definition, doesn't — so this
    // falls back to a plain regex over the raw string instead of leaving
    // embedded credentials (`user:pass@`) to reach stdout/stderr verbatim
    // through this error message.
    throw new Error(`--upstream-proxy: "${redactUnparsedUrlCredentials(url)}" is not a valid URL.`);
  }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `--upstream-proxy: unsupported scheme "${parsed.protocol}" in "${redactProxyUrlCredentials(url)}" — expected http:, https:, socks:, socks4:, socks4a:, socks5:, or socks5h:.`,
    );
  }
  return parsed;
}

/** Best-effort credential redaction for a URL that failed to parse at all — `redactProxyUrlCredentials`'s `new URL(...)`-based approach can't run against it, so this instead strips anything shaped like `scheme://user:pass@` directly out of the raw string. */
function redactUnparsedUrlCredentials(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z\d+\-.]*:\/\/)[^/?#]*@/, '$1***@');
}

/**
 * Redacts embedded credentials (`user:pass@`) from an `--upstream-proxy`
 * URL for display (the CLI's startup banner) — a proxy URL routinely
 * carries real auth, unlike every other path/URL this banner already
 * prints verbatim. Returns `url` unchanged if it carries no credentials or
 * doesn't parse as a URL at all (already validated by this point via
 * `validateUpstreamProxyUrl`, so the latter shouldn't happen in practice).
 */
export function redactProxyUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href.replace(`${parsed.protocol}//`, `${parsed.protocol}//***@`);
  } catch {
    return url;
  }
}

/**
 * Builds the `{httpAgent, httpsAgent}` pair `ProxyEngine` forwards every
 * proxy→upstream request through when `--upstream-proxy` is configured
 * (issue #145) — routing via an existing HTTP(S)/SOCKS proxy instead of
 * connecting to the real destination directly, for a network (e.g. a
 * corporate egress) only reachable that way. Credentials/auth, if any, are
 * carried in `upstreamProxyUrl` itself (`scheme://user:pass@host:port`) —
 * each agent class reads them from the URL it's constructed with.
 *
 * A SOCKS upstream proxy shares a single agent instance for both plain-HTTP
 * and HTTPS destinations: `SocksProxyAgent` (like every `agent-base`
 * subclass) decides whether to TLS-wrap the tunnel per request from Node's
 * own `secureEndpoint` option (set automatically depending on whether
 * `http.request`/`https.request` initiated it), not from which agent
 * instance handled it. An HTTP(S) upstream proxy needs two different
 * instances instead: `HttpProxyAgent` rewrites the request into
 * absolute-form and sends it to the proxy as-is (a plain-HTTP destination),
 * while `HttpsProxyAgent` issues a `CONNECT` and TLS-wraps the tunnel
 * itself (an HTTPS destination) — the same http/https split
 * `http-proxy-agent`/`https-proxy-agent` exist for.
 *
 * Both returned agents satisfy plain `http.Agent` (matching
 * `IContext.proxyToServerRequestOptions.agent`'s own type — see
 * `src/types/proxy-agents.d.ts`'s ambient declarations) even though the
 * HTTPS-destination one does TLS underneath — `http.request`/`https.request`
 * only care that the object behaves like an `http.Agent` at runtime, not
 * which concrete subclass it is.
 */
export function createUpstreamProxyAgents(upstreamProxyUrl: string): { httpAgent: http.Agent; httpsAgent: http.Agent } {
  const parsed = validateUpstreamProxyUrl(upstreamProxyUrl);
  // `ProxyEngine`'s own default agents are `keepAlive: false` (see
  // `proxyEngine.ts`) and every proxy→upstream response is sent with
  // `Connection: close` on the strength of that — a socket can then only
  // ever be in a fresh "connecting" state, which `trackSocketTiming` relies
  // on to measure every timing phase on every request. These three
  // constructors already default to `keepAlive: false` themselves (Node's
  // own `http.Agent` default, which `agent-base` doesn't override), so this
  // doesn't change current behavior — it's here so that invariant doesn't
  // silently start depending on an undocumented default if one of these
  // packages ever changes it.
  const keepAlive = { keepAlive: false };
  if (SOCKS_SCHEMES.has(parsed.protocol)) {
    const agent = new SocksProxyAgent(parsed, keepAlive);
    return { httpAgent: agent, httpsAgent: agent };
  }
  return { httpAgent: new HttpProxyAgent(parsed, keepAlive), httpsAgent: new HttpsProxyAgent(parsed, keepAlive) };
}
