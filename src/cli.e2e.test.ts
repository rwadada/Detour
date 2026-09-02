import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import protobuf from 'protobufjs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Starts a plain HTTP server (the "real" upstream a proxied request should
 * reach) that echoes back method/path/headers/body as JSON.
 */
function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            path: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind echo server'));
      resolve({
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * Starts a plain HTTP server that always responds with a fixed-size body
 * (`'a'` repeated `bodyBytes` times), regardless of the request — used by
 * the Throttle bandwidth tests, where the response size (not its content)
 * is what matters.
 */
function startFixedBodyServer(bodyBytes: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const body = 'a'.repeat(bodyBytes);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind fixed-body server'));
      resolve({
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * Starts a raw TCP server that prefixes whatever it receives with `marker`
 * and echoes it straight back — deliberately not HTTP or TLS. Used to prove
 * a CONNECT tunnel is a genuine byte-level passthrough (a real MITM would
 * instead try to TLS-terminate the tunnel and never get here), and which of
 * two such servers actually received a routed connection.
 */
function startMarkerEchoServer(marker: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => socket.write(`${marker}:${chunk.toString('utf8')}`));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind marker echo server'));
      resolve({
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

const HELLOWORLD_PROTO_SOURCE = `
syntax = "proto3";
package helloworld;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
`;

/** Writes the shared `helloworld.proto` fixture to a fresh tmp dir, returning its path. */
function writeHelloworldProtoFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-grpc-'));
  const file = path.join(dir, 'helloworld.proto');
  fs.writeFileSync(file, HELLOWORLD_PROTO_SOURCE, 'utf8');
  return file;
}

/** Wraps a Protobuf-encoded payload in a single gRPC wire frame (1-byte flags + 4-byte BE length), uncompressed. */
function grpcFrame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Starts a plain-HTTP "gRPC-like" upstream server: reads a single framed
 * `HelloRequest` and replies with a framed `HelloReply` greeting it by
 * name — the same wire framing and content-type real gRPC uses, just
 * carried over HTTP/1.1 (this proxy's own transport today), so the
 * detect/decode logic under test never depends on which HTTP version
 * actually carried the bytes.
 */
function startGrpcUpstreamServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const root = protobuf.parse(HELLOWORLD_PROTO_SOURCE).root;
    const HelloRequest = root.lookupType('helloworld.HelloRequest');
    const HelloReply = root.lookupType('helloworld.HelloReply');
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const { name } = HelloRequest.toObject(HelloRequest.decode(body.subarray(5))) as { name: string };
        const reply = grpcFrame(HelloReply.encode({ message: `Hello, ${name}!` }).finish());
        res.writeHead(200, { 'Content-Type': 'application/grpc+proto' });
        res.end(reply);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind grpc upstream server'));
      resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/**
 * Same as `requestThroughProxy`, but issues a POST with a binary body and
 * returns a binary-safe response body — needed for gRPC's length-prefixed
 * framing, which `toString('utf8')` would corrupt.
 */
function postThroughProxy(
  proxyPort: number,
  targetPort: number,
  reqPath: string,
  request: { headers: http.OutgoingHttpHeaders; body: Buffer },
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port: proxyPort,
        path: `http://127.0.0.1:${targetPort}${reqPath}`,
        method: 'POST',
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(request.body);
  });
}

/**
 * Opens a raw TCP connection to the proxy and issues a CONNECT to
 * `targetHost:targetPort`, resolving with the socket once the tunnel is
 * established (after the `200` response header) — any tunnel bytes that
 * arrived in the same packet are pushed back for the next read.
 */
function connectTunnel(proxyPort: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: 'localhost', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      socket.off('data', onData);
      const statusLine = buffered.subarray(0, headerEnd).toString('utf8');
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`CONNECT failed: ${statusLine}`));
        return;
      }
      const rest = buffered.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** Writes `data` to `socket` and resolves with the next chunk it receives back. */
function writeAndRead(socket: net.Socket, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    socket.once('error', reject);
    socket.write(data);
  });
}

/**
 * Toggles intercept on/off through the dashboard's `/ws` — the same command
 * a connected browser tab sends — and waits for the server to broadcast
 * back that it actually applied, so the caller can rely on the new state
 * being in effect for whatever it does next.
 */
function setIntercept(dashboardPort: number, enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'setIntercept', enabled })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; state?: { enabled: boolean } };
      if (message.type === 'intercept' && message.state?.enabled === enabled) {
        socket.close();
        resolve();
      }
    });
    socket.on('error', reject);
  });
}

/**
 * Sets the "Focus" host allowlist through the dashboard's `/ws`, the same
 * way `setIntercept` toggles interception — waits for the server to
 * broadcast the change back before resolving.
 */
function setFocus(dashboardPort: number, hosts: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'setFocus', hosts })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; state?: { hosts: string[] } };
      if (message.type === 'focus' && JSON.stringify(message.state?.hosts) === JSON.stringify(hosts)) {
        socket.close();
        resolve();
      }
    });
    socket.on('error', reject);
  });
}

interface ThrottleProfile {
  enabled: boolean;
  downKbps: number;
  upKbps: number;
  latencyMs: number;
  packetLossPct: number;
}

/**
 * Sets the "Throttle" network-simulation profile through the dashboard's
 * `/ws`, the same way `setFocus`/`setIntercept` do — waits for the server to
 * broadcast the change back before resolving.
 */
function setThrottle(dashboardPort: number, state: ThrottleProfile): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'setThrottle', state })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; state?: ThrottleProfile };
      if (message.type === 'throttle' && JSON.stringify(message.state) === JSON.stringify(state)) {
        socket.close();
        resolve();
      }
    });
    socket.on('error', reject);
  });
}

interface BlockHostsProfile {
  hosts: string[];
  mode: 'forbidden' | 'reset';
}

/**
 * Sets the "Block Hosts" denylist through the dashboard's `/ws`, the same
 * way `setFocus`/`setThrottle` do — waits for the server to broadcast the
 * change back before resolving.
 */
function setBlockHosts(dashboardPort: number, state: BlockHostsProfile): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'setBlockHosts', state })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; state?: BlockHostsProfile };
      if (message.type === 'blockHosts' && JSON.stringify(message.state) === JSON.stringify(state)) {
        socket.close();
        resolve();
      }
    });
    socket.on('error', reject);
  });
}

/** Requests `path` through the given HTTP proxy, to `http://127.0.0.1:targetPort`. */
function requestThroughProxy(
  proxyPort: number,
  targetPort: number,
  reqPath: string,
  headers?: http.OutgoingHttpHeaders,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Connect via the hostname `detour start` itself binds to by default
    // (see proxyServer.ts's `host = options.host ?? 'localhost'`) — not a
    // hardcoded '127.0.0.1', which can resolve to a different address
    // family than whatever `localhost` resolved to when the server bound,
    // and silently ECONNREFUSE.
    const req = http.request(
      {
        host: 'localhost',
        port: proxyPort,
        path: `http://127.0.0.1:${targetPort}${reqPath}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Spawns `detour start` (via `tsx`, straight from source — no build step
 * needed) with ephemeral ports (`--port 0 --dashboard-port 0`, avoiding any
 * port-conflict flakiness) and waits for its startup banner to report the
 * port it actually bound.
 */
async function startDetourCli(
  args: string[] = [],
): Promise<{ port: number; dashboardPort: number; stdout: () => string; kill: () => Promise<void> }> {
  const subprocess = execa('npx', ['tsx', 'src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', ...args], {
    cwd: REPO_ROOT,
    reject: false,
  });

  let stdout = '';
  subprocess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  let stderr = '';
  subprocess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const start = Date.now();
  while (!/Dashboard →/.test(stdout)) {
    if (Date.now() - start > 15_000) {
      subprocess.kill();
      throw new Error(`detour start never printed its ready banner.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const portMatch = stdout.match(/Detour proxy started .*http:\/\/localhost:(\d+)/);
  if (!portMatch) throw new Error(`could not parse proxy port from stdout: ${stdout}`);
  const dashboardMatch = stdout.match(/Dashboard → http:\/\/localhost:(\d+)/);
  if (!dashboardMatch) throw new Error(`could not parse dashboard port from stdout: ${stdout}`);

  return {
    port: Number(portMatch[1]),
    dashboardPort: Number(dashboardMatch[1]),
    stdout: () => stdout,
    kill: async () => {
      subprocess.kill('SIGTERM');
      await subprocess.catch(() => {}); // a killed process "fails" — that's expected, not a test failure.
    },
  };
}

/** Polls `cli.stdout()` until it matches `pattern`, throwing after 5s (see `startDetourCli`'s ready-banner loop). */
async function waitForStdout(cli: { stdout: () => string }, pattern: RegExp): Promise<void> {
  const start = Date.now();
  while (!pattern.test(cli.stdout())) {
    if (Date.now() - start > 5_000) {
      throw new Error(`stdout never matched ${pattern}.\nstdout: ${cli.stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('detour start (CLI, end-to-end)', () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>> | undefined;
  let cli: Awaited<ReturnType<typeof startDetourCli>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await cli?.kill();
    await echo?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    cli = undefined;
    echo = undefined;
    tmpDir = undefined;
  });

  it('proxies a plain HTTP request through to the real upstream server', async () => {
    echo = await startEchoServer();
    cli = await startDetourCli();

    const result = await requestThroughProxy(cli.port, echo.port, '/hello');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello', body: '' });
  });

  it('serves a mock response from rules.json instead of contacting the real upstream server', async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-mock',
            match: { url: `http://127.0.0.1:${echo.port}/mocked` },
            action: { type: 'mock', status: 200, body: { mocked: true } },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const result = await requestThroughProxy(cli.port, echo.port, '/mocked');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ mocked: true });
  });

  describe('intercept on/off (issue #11)', () => {
    it('skips a mock rule while intercept is off, reaching the real upstream instead', async () => {
      echo = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-mock',
              match: { url: `http://127.0.0.1:${echo.port}/mocked` },
              action: { type: 'mock', status: 200, body: { mocked: true } },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setIntercept(cli.dashboardPort, false);

      const result = await requestThroughProxy(cli.port, echo.port, '/mocked');
      expect(result.status).toBe(200);
      // The mock rule never fired — this is the real echo server's response.
      expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/mocked', body: '' });
    });

    it('keeps applying a route rule for plain HTTP while intercept is off', async () => {
      echo = await startEchoServer();
      const routed = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-route',
              match: { url: `http://127.0.0.1:${echo.port}/*` },
              action: { type: 'route', host: '127.0.0.1', port: routed.port },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setIntercept(cli.dashboardPort, false);

      try {
        const result = await requestThroughProxy(cli.port, echo.port, '/routed');
        expect(result.status).toBe(200);
        // Reached `routed`'s server, not the one the request was addressed to.
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/routed', body: '' });
      } finally {
        await routed.close();
      }
    });

    it('blind-tunnels a CONNECT while intercept is off instead of MITM-decrypting it', async () => {
      const upstream = await startMarkerEchoServer('upstream');
      cli = await startDetourCli();
      await setIntercept(cli.dashboardPort, false);

      let socket: net.Socket | undefined;
      try {
        socket = await connectTunnel(cli.port, '127.0.0.1', upstream.port);
        // Neither valid HTTP nor a TLS ClientHello — a genuine MITM would try
        // to terminate TLS on this tunnel and never get a sensible reply.
        // A raw passthrough just relays the bytes straight to `upstream`.
        const reply = await writeAndRead(socket, 'ping');
        expect(reply).toBe('upstream:ping');
      } finally {
        socket?.destroy();
        await upstream.close();
      }
    });

    it('keeps applying a route rule to a CONNECT tunnel while intercept is off', async () => {
      const original = await startMarkerEchoServer('original');
      const routed = await startMarkerEchoServer('routed');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-connect-route',
              // No path to match on for a never-decrypted tunnel — see
              // `connectMatchUrl` in proxyServer.ts.
              match: { url: `https://127.0.0.1:${original.port}` },
              action: { type: 'route', host: '127.0.0.1', port: routed.port },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setIntercept(cli.dashboardPort, false);

      let socket: net.Socket | undefined;
      try {
        socket = await connectTunnel(cli.port, '127.0.0.1', original.port);
        const reply = await writeAndRead(socket, 'ping');
        expect(reply).toBe('routed:ping');
      } finally {
        socket?.destroy();
        await original.close();
        await routed.close();
      }
    });
  });

  describe('focus (issue #12)', () => {
    it('applies a mock rule to a focused host but skips it (reaching the real upstream) for one outside the list', async () => {
      const focused = await startEchoServer();
      const unfocused = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-mock',
              match: { url: 'http://*/mocked' },
              action: { type: 'mock', status: 200, body: { mocked: true } },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setFocus(cli.dashboardPort, [`127.0.0.1:${focused.port}`]);

      try {
        const focusedResult = await requestThroughProxy(cli.port, focused.port, '/mocked');
        expect(focusedResult.status).toBe(200);
        expect(JSON.parse(focusedResult.body)).toEqual({ mocked: true });

        const unfocusedResult = await requestThroughProxy(cli.port, unfocused.port, '/mocked');
        expect(unfocusedResult.status).toBe(200);
        // The mock rule never fired for the unfocused host — this is the real echo server's response.
        expect(JSON.parse(unfocusedResult.body)).toEqual({ method: 'GET', path: '/mocked', body: '' });
      } finally {
        await unfocused.close();
      }
    });

    it('keeps applying a route rule for plain HTTP to a host outside the focus list', async () => {
      echo = await startEchoServer();
      const routed = await startEchoServer();
      const somewhereElse = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-route',
              match: { url: `http://127.0.0.1:${echo.port}/*` },
              action: { type: 'route', host: '127.0.0.1', port: routed.port },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      // Focused on a host that isn't `echo` — the route rule should still fire for it.
      await setFocus(cli.dashboardPort, [`127.0.0.1:${somewhereElse.port}`]);

      try {
        const result = await requestThroughProxy(cli.port, echo.port, '/routed');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/routed', body: '' });
      } finally {
        await routed.close();
        await somewhereElse.close();
      }
    });

    it('blind-tunnels a CONNECT to a host outside the focus list instead of MITM-decrypting it', async () => {
      const upstream = await startMarkerEchoServer('upstream');
      const somewhereElse = await startEchoServer();
      cli = await startDetourCli();
      await setFocus(cli.dashboardPort, [`127.0.0.1:${somewhereElse.port}`]);

      let socket: net.Socket | undefined;
      try {
        socket = await connectTunnel(cli.port, '127.0.0.1', upstream.port);
        const reply = await writeAndRead(socket, 'ping');
        expect(reply).toBe('upstream:ping');
      } finally {
        socket?.destroy();
        await upstream.close();
        await somewhereElse.close();
      }
    });

    it('keeps applying a route rule to a CONNECT tunnel outside the focus list', async () => {
      const original = await startMarkerEchoServer('original');
      const routed = await startMarkerEchoServer('routed');
      const somewhereElse = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-connect-route',
              match: { url: `https://127.0.0.1:${original.port}` },
              action: { type: 'route', host: '127.0.0.1', port: routed.port },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setFocus(cli.dashboardPort, [`127.0.0.1:${somewhereElse.port}`]);

      let socket: net.Socket | undefined;
      try {
        socket = await connectTunnel(cli.port, '127.0.0.1', original.port);
        const reply = await writeAndRead(socket, 'ping');
        expect(reply).toBe('routed:ping');
      } finally {
        socket?.destroy();
        await original.close();
        await routed.close();
        await somewhereElse.close();
      }
    });

    it('clearing the focus list goes back to intercepting every host', async () => {
      echo = await startEchoServer();
      const other = await startEchoServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-mock',
              match: { url: 'http://*/mocked' },
              action: { type: 'mock', status: 200, body: { mocked: true } },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath]);
      await setFocus(cli.dashboardPort, [`127.0.0.1:${other.port}`]);
      // `echo` isn't focused yet — confirm the mock is indeed skipped before clearing.
      const beforeClear = await requestThroughProxy(cli.port, echo.port, '/mocked');
      expect(JSON.parse(beforeClear.body)).toEqual({ method: 'GET', path: '/mocked', body: '' });

      await setFocus(cli.dashboardPort, []);

      try {
        const result = await requestThroughProxy(cli.port, echo.port, '/mocked');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ mocked: true });
      } finally {
        await other.close();
      }
    });
  });

  describe('throttle (issue #13)', () => {
    const DISABLED: ThrottleProfile = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 };

    it('delays an exchange by the configured latency', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setThrottle(cli.dashboardPort, { ...DISABLED, enabled: true, latencyMs: 500 });

      const start = Date.now();
      const result = await requestThroughProxy(cli.port, echo.port, '/hello');
      const elapsed = Date.now() - start;

      expect(result.status).toBe(200);
      // Generous lower bound: the real work here (a loopback HTTP round
      // trip) is a couple of ms at most, so anything past ~400ms is
      // unambiguously the simulated latency, not test-runner jitter.
      expect(elapsed).toBeGreaterThanOrEqual(400);
    });

    it('caps download throughput to the configured bandwidth', async () => {
      const fixed = await startFixedBodyServer(1200);
      cli = await startDetourCli();
      // 8 Kbps = 1 byte/ms, so a 1200-byte body should take ~1200ms —
      // comfortably distinguishable from an unthrottled loopback transfer.
      await setThrottle(cli.dashboardPort, { ...DISABLED, enabled: true, downKbps: 8 });

      try {
        const start = Date.now();
        const result = await requestThroughProxy(cli.port, fixed.port, '/');
        const elapsed = Date.now() - start;

        expect(result.status).toBe(200);
        expect(result.body).toHaveLength(1200);
        expect(elapsed).toBeGreaterThanOrEqual(900);
      } finally {
        await fixed.close();
      }
    });

    it('stalls a response by the retransmit delay when packet loss is 100%', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setThrottle(cli.dashboardPort, { ...DISABLED, enabled: true, packetLossPct: 100 });

      const start = Date.now();
      const result = await requestThroughProxy(cli.port, echo.port, '/hello');
      const elapsed = Date.now() - start;

      expect(result.status).toBe(200);
      // Deterministic at 100% loss: every chunk of the (single-chunk) small
      // response body incurs proxyServer.ts's RETRANSMIT_DELAY_MS (300ms).
      expect(elapsed).toBeGreaterThanOrEqual(250);
    });

    it('disabling throttle again restores normal speed', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setThrottle(cli.dashboardPort, { ...DISABLED, enabled: true, latencyMs: 600 });
      const slow = Date.now();
      await requestThroughProxy(cli.port, echo.port, '/hello');
      const slowElapsed = Date.now() - slow;
      expect(slowElapsed).toBeGreaterThanOrEqual(400);

      await setThrottle(cli.dashboardPort, DISABLED);
      const fast = Date.now();
      const result = await requestThroughProxy(cli.port, echo.port, '/hello');
      const fastElapsed = Date.now() - fast;

      expect(result.status).toBe(200);
      expect(fastElapsed).toBeLessThan(300);
    });
  });

  describe('block hosts (issue #14)', () => {
    it('denies a plain HTTP request to a blocked host with 403, without reaching the real upstream', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setBlockHosts(cli.dashboardPort, { hosts: [`127.0.0.1:${echo.port}`], mode: 'forbidden' });

      const result = await requestThroughProxy(cli.port, echo.port, '/blocked');
      expect(result.status).toBe(403);
      // Not the echo server's own JSON response — it was never reached.
      expect(() => JSON.parse(result.body)).toThrow();
    });

    it('resets the connection instead of responding when mode is "reset"', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setBlockHosts(cli.dashboardPort, { hosts: [`127.0.0.1:${echo.port}`], mode: 'reset' });

      await expect(requestThroughProxy(cli.port, echo.port, '/blocked')).rejects.toThrow();
    });

    it('rejects a CONNECT tunnel to a blocked host with a 403 status line, never establishing the tunnel', async () => {
      const upstream = await startMarkerEchoServer('upstream');
      cli = await startDetourCli();
      await setBlockHosts(cli.dashboardPort, { hosts: [`127.0.0.1:${upstream.port}`], mode: 'forbidden' });

      try {
        await expect(connectTunnel(cli.port, '127.0.0.1', upstream.port)).rejects.toThrow(/403/);
      } finally {
        await upstream.close();
      }
    });

    it('never establishes a CONNECT tunnel to a blocked host when mode is "reset"', async () => {
      const upstream = await startMarkerEchoServer('upstream');
      cli = await startDetourCli();
      await setBlockHosts(cli.dashboardPort, { hosts: [`127.0.0.1:${upstream.port}`], mode: 'reset' });

      try {
        const proxyPort = cli.port;
        const established = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: 'localhost', port: proxyPort }, () => {
            socket.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`);
          });
          let sawEstablished = false;
          socket.on('data', (chunk: Buffer) => {
            if (/^HTTP\/1\.[01] 200/.test(chunk.toString('utf8'))) sawEstablished = true;
          });
          // The socket is simply destroyed — whether that surfaces as
          // 'close' or 'error' depends on OS-level TCP RST/FIN timing, so
          // both settle the same way: the tunnel was never established.
          socket.once('close', () => resolve(sawEstablished));
          socket.once('error', () => resolve(sawEstablished));
        });
        expect(established).toBe(false);
      } finally {
        await upstream.close();
      }
    });

    it('clearing the block list goes back to allowing every host', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();
      await setBlockHosts(cli.dashboardPort, { hosts: [`127.0.0.1:${echo.port}`], mode: 'forbidden' });
      const blocked = await requestThroughProxy(cli.port, echo.port, '/hello');
      expect(blocked.status).toBe(403);

      await setBlockHosts(cli.dashboardPort, { hosts: [], mode: 'forbidden' });

      const result = await requestThroughProxy(cli.port, echo.port, '/hello');
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello', body: '' });
    });
  });

  describe('request dump (issue #15)', () => {
    it('summary level (default) logs one line, without full headers/body', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli();

      await requestThroughProxy(cli.port, echo.port, '/hello', { Authorization: 'Bearer secret-token' });
      await waitForStdout(cli, /GET.*\/hello/);

      expect(cli.stdout()).not.toContain('Request headers:');
      expect(cli.stdout()).not.toContain('secret-token');
    });

    it('rejects an invalid --dump level without starting the proxy', async () => {
      const result = await execa(
        'npx',
        ['tsx', 'src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--dump', 'bogus'],
        { cwd: REPO_ROOT, reject: false },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--dump must be one of');
    });

    it('full level prints headers/body to the console, redacting sensitive headers', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli(['--dump', 'full']);

      await requestThroughProxy(cli.port, echo.port, '/hello', { Authorization: 'Bearer secret-token' });
      await waitForStdout(cli, /Request headers:/);

      const stdout = cli.stdout();
      expect(stdout).toContain('authorization: [REDACTED]');
      expect(stdout).not.toContain('secret-token');
      expect(stdout).toContain('Response headers:');
    });

    it('file level writes a redacted dump per exchange instead of printing full details to the console', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli(['--dump', 'file']);
      // Not a security-sensitive use — just a unique-enough marker to pick this test's dump file
      // out of `~/.detour/dumps` among whatever other exchanges land there concurrently.
      // eslint-disable-next-line sonarjs/pseudo-random
      const marker = `dump-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;

      await requestThroughProxy(cli.port, echo.port, `/${marker}`, { Authorization: 'Bearer secret-token' });

      const dumpDir = path.join(os.homedir(), '.detour', 'dumps');
      const start = Date.now();
      let dumpFile: string | undefined;
      while (!dumpFile) {
        dumpFile = fs
          .readdirSync(dumpDir)
          .map((name) => path.join(dumpDir, name))
          .find((file) => fs.readFileSync(file, 'utf8').includes(marker));
        if (dumpFile) break;
        if (Date.now() - start > 5_000) throw new Error(`no dump file matching ${marker} appeared in ${dumpDir}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      try {
        const content = fs.readFileSync(dumpFile, 'utf8');
        expect(content).toContain('authorization: [REDACTED]');
        expect(content).not.toContain('secret-token');
        expect(cli.stdout()).not.toContain('Request headers:');
      } finally {
        fs.rmSync(dumpFile, { force: true });
      }
    });
  });

  describe('gRPC detection and decoding (issue #18)', () => {
    it('detects and tags a gRPC exchange in the default summary log, without --proto', async () => {
      const grpcUpstream = await startGrpcUpstreamServer();
      cli = await startDetourCli();
      try {
        await postThroughProxy(cli.port, grpcUpstream.port, '/helloworld.Greeter/SayHello', {
          headers: { 'Content-Type': 'application/grpc+proto' },
          body: grpcFrame(
            Buffer.from(
              protobuf
                .parse(HELLOWORLD_PROTO_SOURCE)
                .root.lookupType('helloworld.HelloRequest')
                .encode({ name: 'world' })
                .finish(),
            ),
          ),
        });
        await waitForStdout(cli, /\[gRPC helloworld\.Greeter\/SayHello\]/);
        expect(cli.stdout()).toMatch(/\[gRPC helloworld\.Greeter\/SayHello\]/);
      } finally {
        await grpcUpstream.close();
      }
    });

    it('decodes request/response messages via --proto and prints them under --dump full', async () => {
      const grpcUpstream = await startGrpcUpstreamServer();
      const protoPath = writeHelloworldProtoFile();
      cli = await startDetourCli(['--dump', 'full', '--proto', protoPath]);
      try {
        const root = protobuf.parse(HELLOWORLD_PROTO_SOURCE).root;
        const requestBody = grpcFrame(
          Buffer.from(root.lookupType('helloworld.HelloRequest').encode({ name: 'world' }).finish()),
        );

        const result = await postThroughProxy(cli.port, grpcUpstream.port, '/helloworld.Greeter/SayHello', {
          headers: { 'Content-Type': 'application/grpc+proto' },
          body: requestBody,
        });
        expect(result.status).toBe(200);
        await waitForStdout(cli, /gRPC: helloworld\.Greeter\/SayHello/);

        const stdout = cli.stdout();
        expect(stdout).toContain('"name": "world"');
        expect(stdout).toContain('"message": "Hello, world!"');
      } finally {
        await grpcUpstream.close();
        fs.rmSync(path.dirname(protoPath), { recursive: true, force: true });
      }
    });

    it('rejects a broken .proto schema at startup instead of starting the proxy', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-grpc-bad-'));
      const protoPath = path.join(dir, 'broken.proto');
      fs.writeFileSync(protoPath, 'this is not a valid .proto file', 'utf8');
      try {
        const result = await execa(
          'npx',
          ['tsx', 'src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--proto', protoPath],
          { cwd: REPO_ROOT, reject: false },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).not.toBe('');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
