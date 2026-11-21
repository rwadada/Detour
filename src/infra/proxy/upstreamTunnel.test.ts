import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpstreamTunnelConnector } from './upstreamTunnel';

const servers: net.Server[] = [];
const connections: net.Socket[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (connection) => connections.push(connection));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

/** A destination that answers every chunk with `marker:<chunk>`. */
function startEcho(marker: string): Promise<number> {
  return listen(net.createServer((socket) => socket.on('data', (chunk) => socket.write(`${marker}:${chunk}`))));
}

/** A minimal HTTP proxy that answers CONNECT with `status` and, on 200, relays to the requested destination. */
function startConnectProxy(status = 200): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = net.createServer((client) => {
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.off('data', onData);
      requests.push(head.slice(0, end));
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} Nope\r\n\r\n`);
        return;
      }
      const [host, port] = head.split(' ')[1]!.split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
    };
    client.on('data', onData);
  });
  return listen(server).then((port) => ({ port, requests }));
}

/** A minimal SOCKS5 server (no auth, CONNECT only) that records the destinations asked for. */
function startSocks5(): Promise<{ port: number; destinations: string[] }> {
  const destinations: string[] = [];
  const server = net.createServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', (request: Buffer) => {
        const atyp = request[3];
        let host: string;
        let offset: number;
        if (atyp === 3) {
          const length = request[4]!;
          host = request.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else {
          host = [...request.subarray(4, 8)].join('.');
          offset = 8;
        }
        const port = request.readUInt16BE(offset);
        destinations.push(`${host}:${port}`);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
      });
    });
  });
  return listen(server).then((port) => ({ port, destinations }));
}

/** The connector hands over a paused socket (see `UpstreamTunnelConnector`); reading resumes it, as `pipe` would. */
function roundTrip(socket: net.Socket, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
    socket.resume();
    socket.write(data);
  });
}

describe('createUpstreamTunnelConnector', () => {
  it('tunnels through an HTTP proxy with CONNECT, sending credentials from the URL', async () => {
    const echoPort = await startEcho('dest');
    const proxy = await startConnectProxy();
    const connect = createUpstreamTunnelConnector(`http://user:p%40ss@127.0.0.1:${proxy.port}`);

    const socket = await connect('127.0.0.1', echoPort);
    try {
      expect(await roundTrip(socket, 'ping')).toBe('dest:ping');
    } finally {
      socket.destroy();
    }
    expect(proxy.requests[0]).toContain(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1`);
    expect(proxy.requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  });

  it('rejects, naming the status, when the HTTP proxy refuses the CONNECT', async () => {
    const proxy = await startConnectProxy(407);
    const connect = createUpstreamTunnelConnector(`http://127.0.0.1:${proxy.port}`);
    await expect(connect('example.com', 443)).rejects.toThrow(/refused CONNECT to example\.com:443: HTTP\/1\.1 407/);
  });

  it('keeps destination bytes that arrive with the CONNECT answer until the caller reads', async () => {
    // A server that speaks first (an SSH or SMTP banner), with the proxy's answer and the banner in one write.
    const proxyPort = await listen(
      net.createServer((client) => {
        client.once('data', () => client.write('HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-banner\r\n'));
      }),
    );
    const socket = await createUpstreamTunnelConnector(`http://127.0.0.1:${proxyPort}`)('example.com', 22);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100)); // e.g. throttle latency before the relay starts
      const first = await new Promise<string>((resolve) => {
        socket.once('data', (chunk) => resolve(String(chunk)));
        socket.resume();
      });
      expect(first).toBe('SSH-2.0-banner\r\n');
    } finally {
      socket.destroy();
    }
  });

  it('refuses a name the self-target guard rejects, before asking the proxy', async () => {
    const proxy = await startConnectProxy();
    const connect = createUpstreamTunnelConnector(`http://127.0.0.1:${proxy.port}`);
    const lookup = (
      _host: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, a: string, f: number) => void,
    ) => callback(Object.assign(new Error('refusing to connect to Detour itself'), { code: 'ESELF' }), '', 4);
    await expect(connect('rebind.example', 8080, { lookup })).rejects.toThrow(/Detour itself/);
    expect(proxy.requests).toEqual([]);
  });

  it('gives up as soon as the attempt is aborted', async () => {
    // A proxy that never answers.
    const proxyPort = await listen(net.createServer(() => {}));
    const abort = new AbortController();
    const pending = createUpstreamTunnelConnector(`http://127.0.0.1:${proxyPort}`)('example.com', 443, {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('tunnels through a SOCKS5 proxy, leaving name resolution to the proxy for socks5h', async () => {
    const echoPort = await startEcho('dest');
    const socks = await startSocks5();
    const connect = createUpstreamTunnelConnector(`socks5h://127.0.0.1:${socks.port}`);

    const socket = await connect('localhost', echoPort);
    try {
      expect(await roundTrip(socket, 'ping')).toBe('dest:ping');
    } finally {
      socket.destroy();
    }
    expect(socks.destinations).toEqual([`localhost:${echoPort}`]);
  });
});
