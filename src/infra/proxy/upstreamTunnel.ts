import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { SocksClient, type SocksProxy } from 'socks';
import type { GuardedLookup } from './engine/selfTarget';
import { validateUpstreamProxyUrl } from './upstreamProxyAgent';

export interface UpstreamTunnelOptions {
  /**
   * The self-target guard's `lookup` (`ProxyEngine.guardedLookup`), when the
   * tunnel goes to the CONNECT's own target. A name resolved on this machine
   * (`socks4`/`socks5`) is resolved through it; one the proxy resolves itself
   * is checked through it first, so a name that now points at one of Detour's
   * own listeners is refused here rather than handed to a proxy that may run
   * on this very machine.
   */
  lookup?: GuardedLookup;
  /** Aborts the attempt — the client went away before the tunnel was up. */
  signal?: AbortSignal;
}

/**
 * Opens a raw TCP tunnel to `host:port`. Resolves with a *paused* socket
 * whose first bytes from the destination (if any arrived with the proxy's
 * answer) are still in its buffer: the caller resumes it (`pipe`) once it is
 * ready to relay, and nothing is lost in between.
 */
export type UpstreamTunnelConnector = (
  host: string,
  port: number,
  options?: UpstreamTunnelOptions,
) => Promise<net.Socket>;

/** How much of the upstream proxy's CONNECT response is read while looking for the end of its headers. */
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;
/** How long the upstream proxy has to answer before the tunnel is given up on. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * A connector that opens raw tunnels through `--upstream-proxy` (issue #145)
 * instead of connecting to the destination directly: what a CONNECT relayed
 * untouched (Intercept off, a host outside Focus, auto TLS passthrough) needs,
 * so it leaves through the same proxy as the traffic Detour decrypts. HTTP(S)
 * upstream proxies get a `CONNECT`; SOCKS ones a SOCKS connect, resolving the
 * name locally or on the proxy the same way `socks-proxy-agent` does for
 * each scheme. Credentials embedded in the URL are sent as the proxy expects.
 *
 * Its own client rather than the proxy agents' `connect()` (`upstreamProxyAgent.ts`):
 * those are built around an `http.ClientRequest` (they emit on it and, on a
 * refused CONNECT, hand back a fake socket that replays the response to it),
 * which a raw tunnel doesn't have. Trust for an `https:` proxy is Node's
 * default (including `NODE_EXTRA_CA_CERTS`), the same as `HttpsProxyAgent`'s.
 */
export function createUpstreamTunnelConnector(upstreamProxyUrl: string): UpstreamTunnelConnector {
  const proxyUrl = validateUpstreamProxyUrl(upstreamProxyUrl);
  if (proxyUrl.protocol === 'http:' || proxyUrl.protocol === 'https:') {
    return async (host, port, options = {}) => {
      // The proxy resolves the name; refuse it here first if it now points at Detour itself.
      if (options.lookup && !net.isIP(host)) await resolveWith(options.lookup, host, 0);
      return connectViaHttpProxy(proxyUrl, host, port, options.signal);
    };
  }
  return (host, port, options = {}) => connectViaSocksProxy(proxyUrl, host, port, options);
}

function resolveWith(lookup: GuardedLookup, host: string, family: number): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(host, { family }, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

// eslint-disable-next-line max-lines-per-function -- one CONNECT exchange: request, response parsing, timeout and abort in one closure
function connectViaHttpProxy(proxyUrl: URL, host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  const secure = proxyUrl.protocol === 'https:';
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = Number(proxyUrl.port) || (secure ? 443 : 80);
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxyUrl.username || proxyUrl.password) {
    const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
    headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
  }
  const request = `${headers.join('\r\n')}\r\n\r\n`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const socket: net.Socket = secure
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });
    let received = Buffer.alloc(0);
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) {
        if (received.length > MAX_CONNECT_RESPONSE_BYTES)
          fail(new Error('upstream proxy sent an oversized CONNECT response'));
        return;
      }
      const statusLine = received.subarray(0, received.indexOf('\r\n')).toString('latin1');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      if (!(status >= 200 && status < 300)) {
        fail(new Error(`upstream proxy refused CONNECT to ${authority}: ${statusLine || 'no status line'}`));
        return;
      }
      cleanup();
      // Paused before handing over, so destination bytes that came with the answer (or right after) wait in the
      // buffer until the caller pipes the socket, instead of being emitted with no listener.
      socket.pause();
      const rest = received.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error('upstream proxy closed the connection before answering CONNECT'));
    const onTimeout = () => fail(new Error(`upstream proxy did not answer CONNECT within ${CONNECT_TIMEOUT_MS}ms`));
    const onAbort = () => fail(new Error('aborted'));
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
      signal?.removeEventListener('abort', onAbort);
      socket.setTimeout(0);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(request));
  });
}

async function connectViaSocksProxy(
  proxyUrl: URL,
  host: string,
  port: number,
  options: UpstreamTunnelOptions,
): Promise<net.Socket> {
  // Mirrors socks-proxy-agent: `socks4`/`socks5` resolve the name here, `socks4a`/`socks5h`/`socks` on the proxy.
  const scheme = proxyUrl.protocol.slice(0, -1);
  const type = scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5;
  const resolveLocally = scheme === 'socks4' || scheme === 'socks5';
  const proxy: SocksProxy = {
    host: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
    port: Number(proxyUrl.port) || 1080,
    type,
    ...(proxyUrl.username ? { userId: decodeURIComponent(proxyUrl.username) } : {}),
    ...(proxyUrl.password ? { password: decodeURIComponent(proxyUrl.password) } : {}),
  };
  let destinationHost = host;
  if (!net.isIP(host) && (resolveLocally || options.lookup)) {
    const family = type === 4 ? 4 : 0;
    const address = options.lookup
      ? await resolveWith(options.lookup, host, family)
      : (await dns.promises.lookup(host, { family })).address;
    if (resolveLocally) destinationHost = address;
  }
  const { socket } = await SocksClient.createConnection({
    proxy,
    command: 'connect',
    destination: { host: destinationHost, port },
    timeout: CONNECT_TIMEOUT_MS,
  });
  // `socks` hands over bytes that arrived with its handshake by emitting them, then resumes the socket, both on
  // its next turn: hold them across that turn, then pause and put them back so they wait for the caller's pipe.
  // Nothing else listens for 'error' meanwhile (`socks` has let go of the socket), so catch it here.
  const held: Buffer[] = [];
  const hold = (chunk: Buffer) => held.push(chunk);
  let earlyError: Error | undefined;
  const catchError = (err: Error) => {
    earlyError = err;
  };
  socket.on('data', hold);
  socket.on('error', catchError);
  await new Promise((resolve) => setImmediate(resolve));
  socket.pause();
  socket.off('data', hold);
  socket.off('error', catchError);
  if (earlyError || options.signal?.aborted) {
    socket.destroy();
    throw earlyError ?? new Error('aborted');
  }
  if (held.length > 0) socket.unshift(Buffer.concat(held));
  return socket;
}
