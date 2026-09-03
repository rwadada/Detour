import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execa } from 'execa';
import forge from 'node-forge';
import protobuf from 'protobufjs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

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
 * Starts a plain-HTTP WebSocket server (the "real" upstream a proxied `ws://`
 * connection should reach) that echoes every message straight back,
 * preserving whether it was sent as text or binary.
 */
function startWsEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind ws echo server'));
      resolve({
        port: address.port,
        close: () =>
          new Promise((res) => {
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Opens a `ws://` connection to `127.0.0.1:targetPort` tunneled through the
 * proxy at `proxyPort`, the same way a browser configured to use `detour
 * start` as its HTTP proxy would: the TCP socket dials the proxy, while the
 * upgrade request's own `Host`/path still name the real target, so
 * http-mitm-proxy's `Proxy.parseHostAndPort` resolves it correctly (see
 * proxyServer.ts's `resolveWsUrl`). A custom `http.Agent` is the standard
 * way to split "where the socket connects" from "what the request asks
 * for" — the same trick a real HTTP-proxy-aware `ws` client library uses.
 */
function connectWebSocketThroughProxy(
  proxyPort: number,
  targetPort: number,
  wsPath: string,
  headers?: Record<string, string>,
): WebSocket {
  class ProxyAgent extends http.Agent {
    override createConnection(
      _options: http.ClientRequestArgs,
      callback?: (err: Error | null, socket: net.Socket) => void,
    ): net.Socket {
      const socket = net.connect({ host: 'localhost', port: proxyPort });
      socket.once('connect', () => callback?.(null, socket));
      socket.once('error', (err) => callback?.(err, socket));
      return socket;
    }
  }
  return new WebSocket(`ws://127.0.0.1:${targetPort}${wsPath}`, { agent: new ProxyAgent(), headers });
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

/** Generates a throwaway self-signed cert (RSA-2048, sha256) for `commonName`, for a fake HTTPS upstream server. */
function generateSelfSignedCert(commonName: string): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

/**
 * Starts a plain HTTPS server (the "real" upstream an HTTP/2 test connects
 * to through the proxy) with a throwaway self-signed cert — Detour's own
 * outbound request to it therefore needs
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` (see the HTTP/2 describe block below),
 * same as it would for any dev server using a self-signed cert.
 */
function startHttpsUpstreamServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const { key, cert } = generateSelfSignedCert('127.0.0.1');
    const server = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind https upstream server'));
      resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/**
 * Opens a CONNECT tunnel to `targetHost:targetPort` through the proxy (see
 * `connectTunnel`), then performs a real TLS handshake through it —
 * against Detour's dynamically-generated, CA-signed leaf cert for that
 * host — offering `h2` via ALPN. Returns the resulting `http2.ClientHttp2Session`
 * so the caller can inspect `session.alpnProtocol` to confirm HTTP/2 was
 * actually negotiated (not silently downgraded), plus the raw TLS socket
 * for cleanup.
 */
async function connectHttp2ThroughProxy(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  caCertPath: string,
): Promise<{ session: http2.ClientHttp2Session; tlsSocket: tls.TLSSocket }> {
  const tunnelSocket = await connectTunnel(proxyPort, targetHost, targetPort);
  const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({
      socket: tunnelSocket,
      servername: targetHost,
      ca: fs.readFileSync(caCertPath, 'utf8'),
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
  const session = http2.connect(`https://${targetHost}:${targetPort}`, {
    createConnection: () => tlsSocket,
  });
  return { session, tlsSocket };
}

/** Issues a single HTTP/2 GET request over an already-connected session and resolves with its status/body. */
function h2Get(
  session: http2.ClientHttp2Session,
  authority: string,
  reqPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // `:authority` isn't auto-filled from the session's own connect target
    // — set explicitly, since it's what http-mitm-proxy's
    // `Proxy.parseHostAndPort` needs (the HTTP/2 equivalent of the `Host`
    // header) to know which upstream to forward this request to.
    const req = session.request({ ':path': reqPath, ':method': 'GET', ':authority': authority });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
    req.end();
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

/** The subset of `CapturedExchange` (see domain/exchange/types.ts) these tests inspect. */
interface DashboardExchange {
  url: string;
  requestHeaders?: Record<string, string | string[]>;
  responseHeaders?: Record<string, string | string[]>;
}

/**
 * Opens a dashboard `/ws` connection and resolves with the first
 * `request`/`response` broadcast (see dashboardServer.ts's `onRequest`/
 * `onResponse`) whose exchange matches `url` and `phase` — used to inspect
 * exactly what the dashboard would show a user, as opposed to what a test's
 * own HTTP client observes on the wire (`requestThroughProxy` et al.).
 * Connects and resolves its `open` promise before the caller does anything
 * that might trigger the broadcast, so there's no race with a broadcast
 * firing before this is listening.
 */
function waitForExchange(
  dashboardPort: number,
  phase: 'request' | 'response',
  url: string,
): Promise<{
  socket: WebSocket;
  exchange: Promise<DashboardExchange>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    const exchange = new Promise<DashboardExchange>((resolveExchange) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; exchange?: DashboardExchange };
        if (message.type === phase && message.exchange?.url === url) {
          socket.close();
          resolveExchange(message.exchange);
        }
      });
    });
    socket.on('open', () => resolve({ socket, exchange }));
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
  env?: NodeJS.ProcessEnv,
): Promise<{
  port: number;
  dashboardPort: number;
  caCertPath: string;
  stdout: () => string;
  stderr: () => string;
  kill: () => Promise<void>;
}> {
  const subprocess = execa('npx', ['tsx', 'src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', ...args], {
    cwd: REPO_ROOT,
    reject: false,
    env: env ? { ...process.env, ...env } : undefined,
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
  const caCertMatch = stdout.match(/Root CA certificate: (.+)/);
  if (!caCertMatch) throw new Error(`could not parse CA cert path from stdout: ${stdout}`);

  return {
    port: Number(portMatch[1]),
    dashboardPort: Number(dashboardMatch[1]),
    caCertPath: caCertMatch[1]!.trim(),
    stdout: () => stdout,
    stderr: () => stderr,
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

  it("transforms a request and response via a script rule's beforeRequest/beforeResponse hooks (issue #9)", async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeRequest(req) {
          return { body: req.body.toString('utf8') + '-from-script' };
        },
        beforeResponse(req, res) {
          const body = JSON.parse(res.body.toString('utf8'));
          body.scripted = true;
          return { body: JSON.stringify(body) };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script',
            match: { url: `http://127.0.0.1:${echo.port}/scripted` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${echo!.port}/scripted`, method: 'POST' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end('original-body');
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      method: 'POST',
      path: '/scripted',
      body: 'original-body-from-script',
      scripted: true,
    });
  });

  it('forwards a request body larger than the dashboard capture cap unmodified through a script rule', async () => {
    // MAX_CAPTURED_BODY_BYTES (see domain/exchange/bodyCapture.ts) is
    // 256 KiB — the request body a script rule's `beforeRequest` hook sees
    // (and what's actually forwarded upstream) must never be silently
    // truncated to that cap, even though the dashboard's own display copy
    // of the exchange still is.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeRequest(req) {
          return { headers: { ...req.headers, 'x-req-body-length': String(req.body.length) } };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script-big-request',
            match: { url: `http://127.0.0.1:${echo.port}/scripted` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const bigBody = 'x'.repeat(300 * 1024); // > MAX_CAPTURED_BODY_BYTES
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${echo!.port}/scripted`, method: 'POST' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(bigBody);
    });

    expect(result.status).toBe(200);
    // The upstream echo server's own report of what it actually received —
    // if the hook's `req.body` (and thus what got forwarded) had been
    // truncated at the cap, this would come back short.
    expect(JSON.parse(result.body).body).toHaveLength(bigBody.length);
  });

  it('forwards a response body larger than the dashboard capture cap unmodified through a script rule', async () => {
    const bodyBytes = 300 * 1024; // > MAX_CAPTURED_BODY_BYTES
    const fixed = await startFixedBodyServer(bodyBytes);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeResponse(req, res) {
          return { headers: { ...res.headers, 'x-res-body-length': String(res.body.length) } };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script-big-response',
            match: { url: `http://127.0.0.1:${fixed.port}/*` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    try {
      const result = await requestThroughProxy(cli.port, fixed.port, '/big');
      expect(result.status).toBe(200);
      // The hook never touched `body` — this proves what the client
      // actually received (not just what the hook read) was the full,
      // untruncated response.
      expect(result.body).toHaveLength(bodyBytes);
    } finally {
      await fixed.close();
    }
  });

  it("preserves multiple Set-Cookie response headers (as an array, not comma-joined) through a script rule's beforeResponse", async () => {
    const cookieServer = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] });
        res.end('ok');
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('failed to bind cookie server'));
        resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      // Tags the status only — leaves `headers` untouched, so the merge
      // falls back to the original (captured) response headers.
      `module.exports = { beforeResponse() { return { status: 200 }; } };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script-cookies',
            match: { url: `http://127.0.0.1:${cookieServer.port}/*` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    try {
      const setCookie = await new Promise<string[] | undefined>((resolve, reject) => {
        const req = http.request(
          { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${cookieServer.port}/x`, method: 'GET' },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.headers['set-cookie']));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(setCookie).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    } finally {
      await cookieServer.close();
    }
  });

  it("gives a beforeResponse-only script rule's hook the full, untruncated request body as `req.body`", async () => {
    // A rule with only `beforeResponse` (no `beforeRequest`) still needs an
    // accurate `req.body` — the response hook must see what was actually
    // sent, not the dashboard's own capped display copy.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeResponse(req, res) {
          return { headers: { ...res.headers, 'x-observed-req-body-length': String(req.body.length) } };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script-response-only-sees-full-request',
            match: { url: `http://127.0.0.1:${echo.port}/scripted` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const bigBody = 'x'.repeat(300 * 1024); // > MAX_CAPTURED_BODY_BYTES
    const observedLength = await new Promise<string | string[] | undefined>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${echo!.port}/scripted`, method: 'POST' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers['x-observed-req-body-length']));
        },
      );
      req.on('error', reject);
      req.end(bigBody);
    });

    expect(observedLength).toBe(String(bigBody.length));
  });

  it('ignores a case-differently-spelled Content-Length a script hook returns, so a rewritten body is never mis-framed', async () => {
    // If `beforeResponse` returns e.g. `Content-Length` (capitalized) along
    // with a rewritten body, that stale header must not survive — Node
    // would otherwise frame the response by that (now-wrong) byte count
    // and either truncate what the client reads or hang the connection.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeResponse(req, res) {
          const newBody = 'this-is-the-real-rewritten-body-and-it-is-longer-than-3-bytes';
          return { body: newBody, headers: { ...res.headers, 'Content-Length': '3' } };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-script-mismatched-content-length',
            match: { url: `http://127.0.0.1:${echo.port}/scripted` },
            action: { type: 'script', path: 'rules.script.js' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${echo!.port}/scripted`, method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('this-is-the-real-rewritten-body-and-it-is-longer-than-3-bytes');
  });

  it('never shows the dashboard a stale Content-Length a script hook returned but that was stripped before actually sending', async () => {
    // The wire fix (deleteHeader) only touches what's forwarded — the
    // exchange the dashboard displays is built from a *separate* copy, so
    // it needs the exact same case-insensitive strip or it can show a
    // header that was never actually sent to the client/server.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    fs.writeFileSync(
      path.join(tmpDir, 'rules.script.js'),
      `module.exports = {
        beforeRequest(req) {
          return { headers: { ...req.headers, 'Content-Length': '999' } };
        },
        beforeResponse(req, res) {
          return { body: 'rewritten', headers: { ...res.headers, 'Content-Length': '999' } };
        },
      };`,
    );
    const rulesPath = path.join(tmpDir, 'rules.json');
    const url = `http://127.0.0.1:${echo.port}/scripted`;
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          { name: 'e2e-script-dashboard-headers', match: { url }, action: { type: 'script', path: 'rules.script.js' } },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const { socket, exchange: requestExchange } = await waitForExchange(cli.dashboardPort, 'request', url);
    const responseExchange = (await waitForExchange(cli.dashboardPort, 'response', url)).exchange;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: 'localhost', port: cli!.port, path: url, method: 'POST' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end('hi');
    });

    const hasContentLength = (headers: Record<string, string | string[]> | undefined) =>
      Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'content-length');

    expect(hasContentLength((await requestExchange).requestHeaders)).toBe(false);
    expect(hasContentLength((await responseExchange).responseHeaders)).toBe(false);
    socket.close();
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

  describe('HTTP/2 (issue #16)', () => {
    // Detour's outbound request to the fake upstream server below hits its
    // throwaway self-signed cert — the same trust problem a real dev
    // server's self-signed cert would cause, and orthogonal to this
    // describe block's own TLS handshake against Detour's (properly
    // CA-signed) leaf cert, which stays fully verified via `caCertPath`.
    const insecureUpstreamEnv = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };

    it('negotiates HTTP/2 with the client by default and proxies the request through to the (HTTP/1.1) upstream', async () => {
      const upstream = await startHttpsUpstreamServer();
      cli = await startDetourCli([], insecureUpstreamEnv);
      let session: http2.ClientHttp2Session | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      try {
        const connected = await connectHttp2ThroughProxy(cli.port, 'localhost', upstream.port, cli.caCertPath);
        session = connected.session;
        tlsSocket = connected.tlsSocket;
        expect(connected.tlsSocket.alpnProtocol).toBe('h2');

        const result = await h2Get(session, `localhost:${upstream.port}`, '/hello');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello' });

        await waitForStdout(cli, /\[h2\]/);
      } finally {
        session?.close();
        // `session.close()` tears down the HTTP/2 layer, but the raw TLS
        // socket underneath it (returned separately for exactly this) isn't
        // guaranteed to close with it — destroy it explicitly so the test
        // doesn't leak the handle.
        tlsSocket?.destroy();
        await upstream.close();
      }
    });

    it('--no-http2 falls back to HTTP/1.1 only, even though the client offers h2 via ALPN', async () => {
      const upstream = await startHttpsUpstreamServer();
      cli = await startDetourCli(['--no-http2'], insecureUpstreamEnv);
      const { port: proxyPort, caCertPath } = cli;
      try {
        const tunnelSocket = await connectTunnel(proxyPort, 'localhost', upstream.port);
        const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const socket = tls.connect({
            socket: tunnelSocket,
            servername: 'localhost',
            ca: fs.readFileSync(caCertPath, 'utf8'),
            ALPNProtocols: ['h2', 'http/1.1'],
          });
          socket.once('secureConnect', () => resolve(socket));
          socket.once('error', reject);
        });
        try {
          expect(tlsSocket.alpnProtocol).toBe('http/1.1');
        } finally {
          tlsSocket.destroy();
        }
      } finally {
        await upstream.close();
      }
    });

    // The http-mitm-proxy patch's behavioral changes are all gated on the
    // client having negotiated HTTP/2 (see patches/http-mitm-proxy+1.1.0.patch's
    // `clientIsHttp2` checks) — this proves the original HTTP/1.1 HTTPS
    // interception path (what every other exchange in this suite already
    // exercises over a raw CONNECT tunnel, just never through a real TLS
    // handshake against Detour's own leaf cert) is still bit-for-bit intact
    // with HTTP/2 enabled (the new default) but not negotiated.
    it('still decrypts and forwards HTTPS traffic over HTTP/1.1 when the client only offers http/1.1', async () => {
      const upstream = await startHttpsUpstreamServer();
      cli = await startDetourCli([], insecureUpstreamEnv);
      const { port: proxyPort, caCertPath } = cli;
      try {
        const tunnelSocket = await connectTunnel(proxyPort, 'localhost', upstream.port);
        const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const socket = tls.connect({
            socket: tunnelSocket,
            servername: 'localhost',
            ca: fs.readFileSync(caCertPath, 'utf8'),
            ALPNProtocols: ['http/1.1'],
          });
          socket.once('secureConnect', () => resolve(socket));
          socket.once('error', reject);
        });
        try {
          expect(tlsSocket.alpnProtocol).toBe('http/1.1');
          const response = await writeAndRead(
            tlsSocket,
            `GET /hello HTTP/1.1\r\nHost: localhost:${upstream.port}\r\nConnection: close\r\n\r\n`,
          );
          expect(response).toContain('HTTP/1.1 200');
          expect(response).toContain('{"method":"GET","path":"/hello"}');
        } finally {
          tlsSocket.destroy();
        }
      } finally {
        await upstream.close();
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

  describe('websocket logging (issue #17)', () => {
    it('relays messages through a proxied ws:// connection to the real upstream server', async () => {
      const wsEcho = await startWsEchoServer();
      cli = await startDetourCli();
      try {
        const socket = connectWebSocketThroughProxy(cli.port, wsEcho.port, '/chat');
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        const reply = await new Promise<string>((resolve, reject) => {
          socket.once('message', (data: Buffer) => resolve(data.toString('utf8')));
          socket.once('error', reject);
          socket.send('hello');
        });
        expect(reply).toBe('hello');
        socket.close(1000, 'done');
      } finally {
        await wsEcho.close();
      }
    });

    it('logs a closed connection as a summary line by default, without printing frame details', async () => {
      const wsEcho = await startWsEchoServer();
      cli = await startDetourCli();
      try {
        const socket = connectWebSocketThroughProxy(cli.port, wsEcho.port, '/chat');
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        socket.close(1000, 'done');
        await waitForStdout(cli, /WS\s+closed 1000/);

        const stdout = cli.stdout();
        expect(stdout).toContain(`ws://127.0.0.1:${wsEcho.port}/chat`);
        expect(stdout).not.toContain('Frames (');
      } finally {
        await wsEcho.close();
      }
    });

    it('full level prints every captured frame and redacts sensitive upgrade-request headers', async () => {
      const wsEcho = await startWsEchoServer();
      cli = await startDetourCli(['--dump', 'full']);
      try {
        const socket = connectWebSocketThroughProxy(cli.port, wsEcho.port, '/chat', {
          Authorization: 'Bearer secret-token',
        });
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        await new Promise<void>((resolve, reject) => {
          socket.once('message', () => resolve());
          socket.once('error', reject);
          socket.send('hello');
        });
        socket.close(1000, 'done');
        await waitForStdout(cli, /Closed: 1000/);

        const stdout = cli.stdout();
        expect(stdout).toContain(`WS ws://127.0.0.1:${wsEcho.port}/chat`);
        expect(stdout).toContain('→ server text');
        expect(stdout).toContain('→ client text');
        expect(stdout).toContain('authorization: [REDACTED]');
        expect(stdout).not.toContain('secret-token');
      } finally {
        await wsEcho.close();
      }
    });
  });
});
