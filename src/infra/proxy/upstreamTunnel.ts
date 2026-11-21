import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { SocksClient, type SocksProxy } from 'socks';
import { validateUpstreamProxyUrl } from './upstreamProxyAgent';

/** Opens a raw TCP tunnel to `host:port`; resolves once bytes written to the socket reach that destination. */
export type UpstreamTunnelConnector = (host: string, port: number) => Promise<net.Socket>;

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
 */
export function createUpstreamTunnelConnector(upstreamProxyUrl: string): UpstreamTunnelConnector {
  const proxyUrl = validateUpstreamProxyUrl(upstreamProxyUrl);
  if (proxyUrl.protocol === 'http:' || proxyUrl.protocol === 'https:') {
    return (host, port) => connectViaHttpProxy(proxyUrl, host, port);
  }
  return (host, port) => connectViaSocksProxy(proxyUrl, host, port);
}

function connectViaHttpProxy(proxyUrl: URL, host: string, port: number): Promise<net.Socket> {
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
      const rest = received.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error('upstream proxy closed the connection before answering CONNECT'));
    const onTimeout = () => fail(new Error(`upstream proxy did not answer CONNECT within ${CONNECT_TIMEOUT_MS}ms`));
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
      socket.setTimeout(0);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(request));
  });
}

async function connectViaSocksProxy(proxyUrl: URL, host: string, port: number): Promise<net.Socket> {
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
  const destinationHost =
    resolveLocally && !net.isIP(host)
      ? (await dns.promises.lookup(host, { family: type === 4 ? 4 : 0 })).address
      : host;
  const { socket } = await SocksClient.createConnection({
    proxy,
    command: 'connect',
    destination: { host: destinationHost, port },
    timeout: CONNECT_TIMEOUT_MS,
  });
  return socket;
}
