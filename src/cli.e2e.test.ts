import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execa, type Options } from 'execa';
import { HttpsProxyAgent } from 'https-proxy-agent';
import forge from 'node-forge';
import protobuf from 'protobufjs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

const REPO_ROOT = path.resolve(__dirname, '..');

/** tsx's own CLI entry point (resolved via its `exports` map, so this works the same however tsx is installed). */
const TSX_CLI = require.resolve('tsx/cli');

/**
 * Runs `detour`'s CLI under tsx by spawning `node <tsx's cli.mjs> src/cli.ts
 * ...args` directly, rather than `npx tsx ...` or a `node_modules/.bin/tsx`
 * shim:
 *  - `npx` spawns its target as a grandchild of a wrapper process, and on
 *    Linux CI runners that wrapper doesn't reliably forward `SIGTERM` down
 *    to the real process — every `subprocess.kill()` below then hung until
 *    `afterEach`'s hook timeout, even though the CLI itself started and ran
 *    fine (only ever seen on GitHub Actions' ubuntu-latest, never
 *    reproduced locally on macOS).
 *  - `node_modules/.bin/tsx` fixes that (this suite becomes the direct
 *    parent, so signals land immediately) but isn't portable: npm installs
 *    a `.cmd`/`.ps1` shim there on Windows, not a plain `tsx` file.
 * `process.execPath` + tsx's resolved entry script sidesteps both: this
 * process spawns `node` directly (its own binary, always the right one) and
 * async-loads `tsx/cli`'s script, an exports-mapped path resolved by Node
 * itself rather than a hand-built OS-specific one.
 */
function runTsx(args: string[], options?: Options) {
  return execa(process.execPath, [TSX_CLI, ...args], options);
}

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
 * Starts a plain HTTP server that echoes back the exact request headers it
 * received, as JSON — the only way to prove from the outside that a header
 * the client sent to the *proxy* (`Proxy-Authorization`, issue #158) never
 * made it onto the proxy→upstream leg. Also counts the requests that
 * actually arrived, so a test can assert an unauthenticated request was
 * stopped at the proxy rather than merely answered oddly.
 */
function startHeaderEchoServer(): Promise<{
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind header echo server'));
      resolve({
        port: address.port,
        requestCount: () => requestCount,
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
 * Starts an HTTP server that writes its body across `chunkCount` separate
 * `res.write()` calls, each scheduled on its own macrotask (rather than one
 * `res.end(body)`) — forcing genuinely distinct reads on the receiving end
 * regardless of body size or OS/loopback buffering, unlike
 * `startFixedBodyServer`'s single synchronous write. Used to prove Throttle
 * spreads its bandwidth-cap delay across the whole transfer rather than
 * computing one total delay and dumping the entire body in a single write
 * (issue #146).
 */
function startChunkedBodyServer(
  chunkBytes: number,
  chunkCount: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const chunk = Buffer.alloc(chunkBytes, 'a');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      let written = 0;
      const writeNext = () => {
        if (written >= chunkCount) {
          res.end();
          return;
        }
        written++;
        res.write(chunk);
        setTimeout(writeNext, 5);
      };
      // Scheduled too (not called directly) — the doc comment above claims
      // every write is on its own macrotask, but a synchronous first call
      // here would let that first chunk get coalesced with the headers
      // this same tick, weakening the "distinct reads" guarantee the test
      // relies on (Copilot review, PR #153).
      setTimeout(writeNext, 5);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind chunked-body server'));
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
 * `ProxyEngine.parseHostAndPort` resolves it correctly (see
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
function connectTunnel(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  /** Extra request headers for the CONNECT itself — `Proxy-Authorization` for the `--proxy-auth` tests (issue #158). */
  headers: Record<string, string> = {},
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    const socket = net.connect({ host: 'localhost', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${extra}\r\n`);
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
 * Starts a real HTTP/2-only upstream server (issue #166) — `allowHTTP1:
 * false`, so this only ever exercises Detour's own ALPN probe actually
 * negotiating h2 with a real server, not silently falling back and still
 * happening to work over h1. `onTrailers`, when given, is called with the
 * request path and returns trailers to send after the response body — for
 * exercising the gRPC-style `grpc-status`/`grpc-message` trailer forwarding
 * this issue's own acceptance criteria calls out.
 */
function startHttp2UpstreamServer(
  onTrailers?: (path: string) => http2.OutgoingHttpHeaders,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const { key, cert } = generateSelfSignedCert('127.0.0.1');
    const server = http2.createSecureServer({ key, cert, allowHTTP1: false });
    // Detour's own `UpstreamHttp2Pool` deliberately keeps its session to
    // this server open indefinitely for reuse (issue #166's whole point) —
    // `server.close()` alone would then hang forever waiting for that
    // still-open session, same reasoning (and same fix) as the
    // `slowUpstream` helper above for a still-open HTTP/1.1 connection.
    const sockets = new Set<import('node:stream').Duplex>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('stream', (stream, headers) => {
      const reqPath = String(headers[':path'] ?? '/');
      const trailers = onTrailers?.(reqPath);
      stream.respond(
        { ':status': 200, 'content-type': 'application/json' },
        { waitForTrailers: trailers !== undefined },
      );
      if (trailers) stream.once('wantTrailers', () => stream.sendTrailers(trailers));
      stream.end(JSON.stringify({ method: headers[':method'], path: reqPath }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind http2 upstream server'));
      resolve({
        port: address.port,
        close: () =>
          new Promise((res) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Starts an upstream server that offers *both* protocols via ALPN
 * (`allowHTTP1: true`, mirroring exactly how `ProxyEngine`'s own internal
 * MITM'd server is built) and answers either one identically — for testing
 * `--no-http2-upstream` (issue #166): unlike `startHttp2UpstreamServer`'s
 * h2-*only* server (which simply wouldn't accept an HTTP/1.1 connection at
 * all, too blunt an instrument for proving the flag skips the ALPN probe
 * specifically), this lets the same successful request be checked either
 * way — h2 when Detour's probe offers it, h1 when `--no-http2-upstream`
 * means it never does.
 */
function startDualProtocolUpstreamServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const { key, cert } = generateSelfSignedCert('127.0.0.1');
    const server = http2.createSecureServer({ key, cert, allowHTTP1: true });
    // Same still-open-connection reasoning as `startHttp2UpstreamServer`
    // above — Detour's `httpsAgent` (issue #162's keep-alive) or
    // `UpstreamHttp2Pool` (issue #166) can each just as easily be the one
    // keeping a connection to this server open when `close()` runs.
    const sockets = new Set<import('node:stream').Duplex>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('request', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind dual-protocol upstream'));
      resolve({
        port: address.port,
        close: () =>
          new Promise((res) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Generates a CA + a leaf certificate it signs (issue #160) — distinct from
 * `generateSelfSignedCert`'s bare self-signed leaf, for testing
 * `--upstream-ca` trusting a private CA (the case a self-signed leaf can't
 * exercise, since there's no separate CA cert for the flag to point at).
 */
function generateCaAndLeaf(leafCommonName: string): { caPem: string; key: string; cert: string } {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 1);
  const caAttrs = [{ name: 'commonName', value: 'e2e-test-ca' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date();
  leafCert.validity.notAfter.setFullYear(leafCert.validity.notBefore.getFullYear() + 1);
  leafCert.setSubject([{ name: 'commonName', value: leafCommonName }]);
  leafCert.setIssuer(caAttrs);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    key: forge.pki.privateKeyToPem(leafKeys.privateKey),
    cert: forge.pki.certificateToPem(leafCert),
  };
}

/**
 * Starts an HTTPS server with `serverCert` for its own identity, requiring
 * (and verifying against `clientCaPem`) a client certificate — for testing
 * `--client-cert`/`--client-key` (issue #160's mTLS support). Rejects the
 * TLS handshake outright (never reaching the request handler) for a client
 * that doesn't present a cert signed by `clientCaPem`.
 */
function startMtlsUpstreamServer(
  serverCert: { key: string; cert: string },
  clientCaPem: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: serverCert.key, cert: serverCert.cert, ca: clientCaPem, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path: req.url }));
      },
    );
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to bind mTLS upstream server'));
      resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/**
 * Sends one HTTPS request through the proxy's CONNECT tunnel using a real
 * `HttpsProxyAgent` (issue #160) — trusting Detour's own CA (`caCertPath`)
 * for the client↔proxy leg, exactly as a real device configured with it
 * would. Resolves with the response on success, rejects with the
 * connection error on failure (a TLS handshake failure on the upstream leg
 * surfaces to this client as the tunnel dying mid-request, not a clean HTTP
 * error response — there's no status line to send once the CONNECT already
 * answered 200).
 */
function httpsRequestThroughProxy(
  proxyPort: number,
  caCertPath: string,
  targetPort: number,
  reqPath: string,
  clientCert?: { cert: string; key: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // `ca` has to be a per-request option, not the agent's own constructor
    // option — `HttpsProxyAgent`'s constructor-level TLS options only ever
    // apply to its own connection to the (plain-HTTP, in this test) proxy
    // itself, never to the CONNECT-tunneled destination behind it, which
    // reads its TLS options from this per-request `opts` object instead
    // (the exact same distinction `ProxyEngine.forwardRequest`'s own
    // `upstreamTls` threading — issue #160 — has to account for).
    const agent = new HttpsProxyAgent(`http://localhost:${proxyPort}`);
    const req = https.request(
      {
        host: 'localhost',
        port: targetPort,
        path: reqPath,
        method: 'GET',
        agent,
        ca: fs.readFileSync(caCertPath, 'utf8'),
        rejectUnauthorized: true,
        ...clientCert,
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
    // — set explicitly, since it's what `ProxyEngine.parseHostAndPort`
    // needs (the HTTP/2 equivalent of the `Host` header) to know which
    // upstream to forward this request to.
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
  host?: string;
  requestHeaders?: Record<string, string | string[]>;
  responseHeaders?: Record<string, string | string[]>;
  statusCode?: number;
  ruleName?: string;
  passthrough?: boolean;
  error?: string;
  /** Issue #160. */
  certificate?: {
    subject: string;
    issuer: string;
    fingerprint256: string;
    authorized: boolean;
    authorizationError?: string;
  };
  /** Issue #166. */
  upstreamProtocol?: 'HTTP/1.1' | 'HTTP/2';
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

/** The subset of a `BreakpointPayload` (see domain/exchange/types.ts) these tests inspect. */
interface BreakpointHitPayload {
  id: string;
  bodyTruncated: boolean;
}

/**
 * Opens a dashboard `/ws` connection and resolves with the first `breakpoint`
 * broadcast (see dashboardServer.ts's `onBreakpointHit`) for the given
 * `phase` — the payload the dashboard would show a user for a paused
 * exchange, including whether its display copy of the body was truncated.
 * Leaves `socket` open (unlike `waitForExchange`) so the caller can send a
 * `breakpointResume` command back on it once done inspecting the payload.
 * Connects and resolves its `open` promise before the caller does anything
 * that might trigger the broadcast, so there's no race with a broadcast
 * firing before this is listening.
 */
function waitForBreakpoint(
  dashboardPort: number,
  phase: 'request' | 'response',
): Promise<{
  socket: WebSocket;
  payload: Promise<BreakpointHitPayload>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${dashboardPort}/ws`);
    const payload = new Promise<BreakpointHitPayload>((resolvePayload, rejectPayload) => {
      socket.on('message', (raw) => {
        // A malformed/unexpected frame shouldn't throw out of this handler
        // (which would otherwise leave `payload` unsettled and the test
        // hanging until the global timeout) — just ignore it and keep
        // waiting for a frame that actually matches.
        let message: { type: string; payload?: { phase: string } & BreakpointHitPayload };
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.type === 'breakpoint' && message.payload?.phase === phase) {
          resolvePayload(message.payload);
        }
      });
      // If the socket closes/errors before a matching breakpoint message
      // ever arrives, reject rather than leaving `payload` pending forever —
      // otherwise a genuine failure (dashboard crash, connection drop) hangs
      // the test until the suite's global timeout instead of failing fast.
      socket.on('close', () => rejectPayload(new Error('dashboard WebSocket closed before a breakpoint hit')));
      socket.on('error', (err) => rejectPayload(err));
    });
    socket.on('open', () => resolve({ socket, payload }));
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
  cwd: string = REPO_ROOT,
): Promise<{
  port: number;
  dashboardPort: number;
  caCertPath: string;
  stdout: () => string;
  stderr: () => string;
  kill: () => Promise<void>;
}> {
  // An absolute path to `cli.ts`, not the `src/cli.ts` every other caller
  // gets away with — those all run with `cwd: REPO_ROOT` (the default
  // here too), where that relative path and REPO_ROOT-relative resolution
  // coincide. A caller overriding `cwd` (issue #123's "no rules file at
  // startup" tests, which need `process.cwd()` inside the CLI itself to be
  // some other, rules-file-free directory) would otherwise fail to spawn
  // at all once cwd no longer happens to be this repo's root.
  const cliEntry = path.join(REPO_ROOT, 'src/cli.ts');
  const subprocess = runTsx([cliEntry, 'start', '--port', '0', '--dashboard-port', '0', ...args], {
    cwd,
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
  // https:// once --lan defaults the dashboard to TLS (issue #159) — either
  // scheme is a valid "the dashboard bound to this port" signal here.
  const dashboardMatch = stdout.match(/Dashboard → https?:\/\/localhost:(\d+)/);
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

  /**
   * Copilot review, PR #123: applying a Rule Profile with no `ruleEngine`
   * configured lazily bootstraps `passthrough.rule.json` — this covers the
   * race that finding called out, where something *other* than this
   * session (a hand edit, another process) writes that file after `detour
   * start` already committed to running without one (no `--rules`, and the
   * file didn't exist yet at startup) but before a profile is ever applied.
   * The fix loads whatever's already there instead of blindly overwriting
   * it with an empty ruleset — an invalid file (as here) now surfaces as a
   * normal `RULE_PROFILE_ERROR`, rather than being silently replaced,
   * clearing the way for the very same profile apply that would otherwise
   * have failed to instead quietly succeed over content someone else owns.
   */
  it("applying a Rule Profile doesn't clobber a rules file that appeared after startup but is invalid", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    // No `--rules`, and nothing at `passthrough.rule.json` yet — `cli`
    // starts with no `ruleEngine` configured, same as the bug report.
    cli = await startDetourCli([], undefined, tmpDir);

    // Appears *after* startup, as if from another process/hand edit — too
    // late for `cli`'s own auto-detection, which only ever runs once, at
    // startup.
    const rulesPath = path.join(tmpDir, 'passthrough.rule.json');
    fs.writeFileSync(rulesPath, JSON.stringify({ rules: [{ name: 'bad', match: {}, action: { type: 'bogus' } }] }));

    const error = await new Promise<{ errorKind: string; message: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${cli!.dashboardPort}/ws`);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'nonexistent' })));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; event?: { errorKind: string; message: string } };
        if (message.type === 'error' && message.event) {
          socket.close();
          resolve(message.event);
        }
      });
      socket.on('error', reject);
    });

    // The profile itself doesn't even exist — were the fix regressed
    // (unconditionally overwriting the file with `{ rules: [] }` before
    // ever reading it), this would still be the very same error, just for
    // an unrelated reason (`ruleProfileStore.read` failing to find
    // "nonexistent"): the only thing that actually distinguishes "loaded
    // the existing invalid file" from "silently replaced it" is the
    // message's content.
    expect(error.errorKind).toBe('RULE_PROFILE_ERROR');
    expect(error.message).toMatch(/failed validation/i);
    // Untouched — proof nothing was ever written to it.
    expect(JSON.parse(fs.readFileSync(rulesPath, 'utf8'))).toEqual({
      rules: [{ name: 'bad', match: {}, action: { type: 'bogus' } }],
    });
  });

  /**
   * Copilot review, PR #123 (follow-up): the fix above stops
   * `createDefaultRuleEngine()` from clobbering a rules file that appeared
   * after startup, but its console message still unconditionally said
   * "Created" — misleading in exactly that case, since nothing was actually
   * written. This covers the *valid*-file half of that same race (the
   * invalid-file case above never reaches the log line at all, since
   * `RuleEngine.load` throws first), where `createDefaultRuleEngine`
   * succeeds against content it didn't write itself.
   */
  it('logs "Loaded existing", not "Created", when applying a Rule Profile picks up a valid rules file that appeared after startup', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    cli = await startDetourCli([], undefined, tmpDir);

    const rulesPath = path.join(tmpDir, 'passthrough.rule.json');
    fs.writeFileSync(rulesPath, JSON.stringify({ rules: [] }));

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${cli!.dashboardPort}/ws`);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'createRuleProfile', name: 'p', template: 'blank' })));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: { $activeProfile?: string } | null };
        if (message.type === 'ruleProfiles') {
          socket.send(JSON.stringify({ type: 'applyRuleProfile', name: 'p' }));
        }
        // Not the initial post-connect `rules` snapshot (`data: null`, sent
        // before `applyRuleProfile` is even dispatched) — specifically the
        // one confirming this apply actually landed.
        if (message.type === 'rules' && message.data?.$activeProfile === 'p') {
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });

    expect(cli.stdout()).toMatch(/Loaded existing passthrough\.rule\.json/);
    expect(cli.stdout()).not.toMatch(/Created passthrough\.rule\.json/);
  });

  it('finalizes an exchange with the connection error, instead of leaving it "pending" forever, when a route rule targets a host that refuses the connection', async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const rulesPath = path.join(tmpDir, 'rules.json');
    const url = `http://127.0.0.1:${echo.port}/unreachable`;
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-route-unreachable',
            match: { url },
            // Port 1 on loopback: nothing listens there, so the proxy's own
            // outbound connection fails immediately with ECONNREFUSED —
            // deterministic, unlike relying on a DNS lookup to fail.
            action: { type: 'route', host: '127.0.0.1', port: 1 },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    // Connects (and starts listening) before the request below can trigger
    // the broadcast — see `waitForExchange`'s own doc comment on why that
    // ordering matters.
    const { exchange } = await waitForExchange(cli.dashboardPort, 'response', url);
    const result = await requestThroughProxy(cli.port, echo.port, '/unreachable');

    // The proxy already told the client something went wrong...
    expect(result.status).toBeGreaterThanOrEqual(500);
    // ...but before this fix, the dashboard's own copy of the exchange
    // never learned that: `proxy.onError` deleted it from `inFlight`
    // without ever finalizing it, so it broadcast nothing and this
    // `await exchange` would hang until the test's own timeout — visible
    // in the dashboard as a request stuck "pending" forever, though the
    // proxy itself had already logged the error to the console.
    const finalExchange = await exchange;
    expect(finalExchange.error).toBeTruthy();
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

  it('forwards a request body larger than the dashboard capture cap unmodified through a breakpoint rule resumed without edits (issue #95)', async () => {
    // Same cap as the script-rule test above, but exercised through a
    // `breakpoint` rule's request phase instead: resuming a paused request
    // untouched must forward the real, full body upstream — not the
    // dashboard's own capped display copy (MAX_CAPTURED_BODY_BYTES, see
    // domain/exchange/bodyCapture.ts).
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-breakpoint-big-request',
            match: { url: `http://127.0.0.1:${echo.port}/*` },
            action: { type: 'breakpoint', request: true, response: false },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const { socket, payload } = await waitForBreakpoint(cli.dashboardPort, 'request');
    const bigBody = 'x'.repeat(300 * 1024); // > MAX_CAPTURED_BODY_BYTES
    const resultPromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port: cli!.port, path: `http://127.0.0.1:${echo!.port}/bp`, method: 'POST' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(bigBody);
    });

    const hit = await payload;
    // The dashboard's own display copy is truncated (it always caps at
    // MAX_CAPTURED_BODY_BYTES) — confirming that here, rather than assuming
    // it, guards against this test passing were the cap ever raised past
    // this body's size.
    expect(hit.bodyTruncated).toBe(true);
    socket.send(
      JSON.stringify({ type: 'breakpointResume', command: { id: hit.id, phase: 'request', action: 'resume' } }),
    );
    socket.close();

    const result = await resultPromise;
    expect(result.status).toBe(200);
    // The upstream echo server's own report of what it actually received —
    // if the (capped) display copy had been forwarded instead of the real
    // body, this would come back short at MAX_CAPTURED_BODY_BYTES.
    expect(JSON.parse(result.body).body).toHaveLength(bigBody.length);
  });

  it('forwards a response body larger than the dashboard capture cap unmodified through a breakpoint rule resumed without edits (issue #95)', async () => {
    const bodyBytes = 300 * 1024; // > MAX_CAPTURED_BODY_BYTES
    const fixed = await startFixedBodyServer(bodyBytes);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-breakpoint-big-response',
            match: { url: `http://127.0.0.1:${fixed.port}/*` },
            action: { type: 'breakpoint', request: false, response: true },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    try {
      const { socket, payload } = await waitForBreakpoint(cli.dashboardPort, 'response');
      const resultPromise = requestThroughProxy(cli.port, fixed.port, '/big');

      const hit = await payload;
      expect(hit.bodyTruncated).toBe(true);
      socket.send(
        JSON.stringify({ type: 'breakpointResume', command: { id: hit.id, phase: 'response', action: 'resume' } }),
      );
      socket.close();

      const result = await resultPromise;
      expect(result.status).toBe(200);
      // What the client actually received (not the dashboard's own capped
      // display copy) must be the full, untruncated response.
      expect(result.body).toHaveLength(bodyBytes);
    } finally {
      await fixed.close();
    }
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

  it("reflects a `rewrite` rule's request path/header changes in the dashboard's exchange — not the client's original request (bug report: a user asked whether a header Rewrite shows up updated on the dashboard; it didn't)", async () => {
    // `applyRequestRewrite` mutates `ctx.proxyToServerRequestOptions` (the
    // actual outgoing request) — a separate object from the one
    // `buildBaseExchange` already copied `exchange.url`/`requestHeaders`
    // from, captured before this rewrite even runs. Without re-syncing
    // them from what was actually mutated, the dashboard would show the
    // client's original request forever, no matter what the rule rewrote.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const originalUrl = `http://127.0.0.1:${echo.port}/original-path`;
    const rewrittenUrl = `http://127.0.0.1:${echo.port}/rewritten-path`;
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-rewrite-request-dashboard-sync',
            match: { url: originalUrl },
            action: {
              type: 'rewrite',
              request: {
                path: { set: '/rewritten-path' },
                headers: { set: { 'X-Added': 'yes' }, remove: ['x-should-be-removed'] },
              },
            },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    // Not `waitForExchange` (which matches by `exchange.url`): that's
    // exactly the field under test, so on a regression it'd never match
    // the rewritten URL and this test would time out instead of failing
    // cleanly. Matching by rule name instead — stable either way — makes a
    // regression here a fast, direct assertion failure.
    const socket = new WebSocket(`ws://localhost:${cli.dashboardPort}/ws`);
    const requestExchange = new Promise<DashboardExchange>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; exchange?: DashboardExchange };
        if (message.type === 'request' && message.exchange?.ruleName === 'e2e-rewrite-request-dashboard-sync') {
          resolve(message.exchange);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: 'localhost',
          port: cli!.port,
          path: originalUrl,
          method: 'GET',
          headers: { 'X-Should-Be-Removed': 'x' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    const exchange = await requestExchange;
    expect(exchange.url).toBe(rewrittenUrl);
    expect(exchange.requestHeaders?.['X-Added']).toBe('yes');
    // Case-insensitive: `exchange.requestHeaders` is a spread of Node's own
    // `IncomingMessage.headers`, which always lowercases keys — a stale
    // "X-Should-Be-Removed" (exact case) lookup would pass even if removal
    // silently failed and it survived as "x-should-be-removed" instead.
    const hasHeader = (headers: Record<string, string | string[]> | undefined, name: string) =>
      Object.keys(headers ?? {}).some((k) => k.toLowerCase() === name.toLowerCase());
    expect(hasHeader(exchange.requestHeaders, 'X-Should-Be-Removed')).toBe(false);
    socket.close();
  });

  it("reflects a `rewrite` rule's response status/header changes in the dashboard's exchange — not upstream's original response", async () => {
    // `applyResponseHeaderRewrite` runs from `onResponseHeaders`, which
    // (per ProxyEngine.onUpstreamResponse) fires *after* the plain
    // `onResponse` handler that captures `exchange.statusCode`/
    // `responseHeaders` — so without re-syncing them from what was
    // actually just mutated, the dashboard would show upstream's original
    // response forever, same class of bug as the request side above.
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const url = `http://127.0.0.1:${echo.port}/rewritten-response`;
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-rewrite-response-dashboard-sync',
            match: { url },
            action: { type: 'rewrite', response: { status: 201, headers: { set: { 'X-Added': 'yes' } } } },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const { socket, exchange: responseExchange } = await waitForExchange(cli.dashboardPort, 'response', url);

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: 'localhost', port: cli!.port, path: url, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });

    const exchange = await responseExchange;
    expect(exchange.statusCode).toBe(201);
    expect(exchange.responseHeaders?.['X-Added']).toBe('yes');
    socket.close();
  });

  it('applies every matching `rewrite` rule to the same request, not just the first (bug report: a broad "add this header to everything" rule silently blocked a narrower rewrite rule below it from ever running)', async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          // Broad, listed first — matches every request to this host, same
          // as a user adding one header everywhere.
          {
            name: 'e2e-cumulative-common-header',
            match: { url: `http://127.0.0.1:${echo.port}/*` },
            action: { type: 'rewrite', request: { headers: { set: { 'X-Common': 'always' } } } },
          },
          // Narrower, listed second — under the old "first match wins"
          // engine this rule would never even be reached for a request the
          // rule above also matched.
          {
            name: 'e2e-cumulative-narrow-query',
            match: { url: `http://127.0.0.1:${echo.port}/narrow*` },
            action: { type: 'rewrite', request: { query: { set: { special: 'yes' } } } },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const socket = new WebSocket(`ws://localhost:${cli.dashboardPort}/ws`);
    const narrowRequestExchange = new Promise<DashboardExchange>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; exchange?: DashboardExchange };
        if (message.type === 'request' && message.exchange?.url?.includes('/narrow-endpoint')) {
          resolve(message.exchange);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const result = await requestThroughProxy(cli.port, echo.port, '/narrow-endpoint');
    // Both rules' request-side changes reached the real upstream — the echo
    // server's response reflects the query-string rewrite in `path`.
    expect(JSON.parse(result.body).path).toBe('/narrow-endpoint?special=yes');

    const exchange = await narrowRequestExchange;
    expect(exchange.ruleName).toBe('e2e-cumulative-common-header, e2e-cumulative-narrow-query');
    expect(exchange.requestHeaders?.['X-Common']).toBe('always');
    expect(exchange.url).toBe(`http://127.0.0.1:${echo.port}/narrow-endpoint?special=yes`);
    socket.close();

    // A request that only the broad rule matches still gets its header, but
    // isn't also subject to the narrow rule's query rewrite.
    const other = await requestThroughProxy(cli.port, echo.port, '/other-endpoint');
    expect(JSON.parse(other.body).path).toBe('/other-endpoint');
  });

  it("applies a matching `rewrite` rule's request-side changes even when a later `mock` rule terminates the request (Copilot review, PR #150: `ruleName` joined both rules' names, implying the rewrite took effect, but the mock's early return skipped the rewrite loop entirely)", async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const url = `http://127.0.0.1:${echo.port}/mocked-with-rewrite`;
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-rewrite-before-mock',
            match: { url },
            action: { type: 'rewrite', request: { headers: { set: { 'X-Added': 'yes' } } } },
          },
          {
            name: 'e2e-mock-terminal',
            match: { url },
            action: { type: 'mock', status: 200, body: 'mocked' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const socket = new WebSocket(`ws://localhost:${cli.dashboardPort}/ws`);
    const requestExchange = new Promise<DashboardExchange>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; exchange?: DashboardExchange };
        if (message.type === 'request' && message.exchange?.ruleName?.includes('e2e-mock-terminal')) {
          resolve(message.exchange);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: 'localhost', port: cli!.port, path: url, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });

    const exchange = await requestExchange;
    expect(exchange.ruleName).toBe('e2e-rewrite-before-mock, e2e-mock-terminal');
    expect(exchange.requestHeaders?.['X-Added']).toBe('yes');
    socket.close();
  });

  it("applies a matching `rewrite` rule's response-side changes to a `mock` rule's own response (Copilot review, PR #150: a mock's response never passes through onResponseHeaders/onResponse, so a response rewrite silently never reached it even though `ruleName` implied it had)", async () => {
    echo = await startEchoServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
    const url = `http://127.0.0.1:${echo.port}/mocked-with-response-rewrite`;
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            name: 'e2e-response-rewrite-before-mock',
            match: { url },
            action: {
              type: 'rewrite',
              response: { status: 201, headers: { set: { 'X-Added': 'yes' } }, body: { set: 'rewritten' } },
            },
          },
          {
            name: 'e2e-mock-terminal-2',
            match: { url },
            action: { type: 'mock', status: 200, body: 'mocked' },
          },
        ],
      }),
    );
    cli = await startDetourCli(['--rules', rulesPath]);

    const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = http.request({ host: 'localhost', port: cli!.port, path: url, method: 'GET' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
        req.on('error', reject);
        req.end();
      },
    );

    // The rewrite rule's response changes reached the actual client, not
    // just the mock rule's own status:200/body:"mocked".
    expect(result.status).toBe(201);
    expect(result.headers['x-added']).toBe('yes');
    expect(result.body).toBe('rewritten');
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

    it('shows a passthrough CONNECT tunnel in the dashboard as the destination it went to — never its (unobservable) contents', async () => {
      const upstream = await startMarkerEchoServer('upstream');
      cli = await startDetourCli();
      await setIntercept(cli.dashboardPort, false);

      const url = `https://127.0.0.1:${upstream.port}`;
      const requestExchange = (await waitForExchange(cli.dashboardPort, 'request', url)).exchange;
      const responseExchange = (await waitForExchange(cli.dashboardPort, 'response', url)).exchange;

      let socket: net.Socket | undefined;
      try {
        socket = await connectTunnel(cli.port, '127.0.0.1', upstream.port);
        expect(await writeAndRead(socket, 'ping')).toBe('upstream:ping');
      } finally {
        // Triggers the tunnel's own 'close' teardown in proxyServer.ts,
        // which is what emits the `response` half below — a passthrough
        // tunnel otherwise stays open indefinitely, same as any other
        // CONNECT tunnel.
        socket?.destroy();
        await upstream.close();
      }

      const request = await requestExchange;
      expect(request.passthrough).toBe(true);
      expect(request.host).toBe(`127.0.0.1:${upstream.port}`);

      const response = await responseExchange;
      expect(response.passthrough).toBe(true);
      expect(response.error).toBeUndefined();
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
              // eslint-disable-next-line sonarjs/no-clear-text-protocols -- rule-matcher glob string, never used as an outbound request URL
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
              // eslint-disable-next-line sonarjs/no-clear-text-protocols -- rule-matcher glob string, never used as an outbound request URL
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

    it("streams a throttled MITM'd body chunk-by-chunk rather than delivering it in one delayed write (issue #146)", async () => {
      const chunkBytes = 8000;
      const chunkCount = 4;
      const chunked = await startChunkedBodyServer(chunkBytes, chunkCount);
      try {
        cli = await startDetourCli();
        // 64 Kbps = 8 bytes/ms, so each 8000-byte chunk should individually
        // take ~1000ms to "transmit" (BandwidthState paces per chunk, not
        // just the whole body) — ~4000ms end-to-end for all four.
        await setThrottle(cli.dashboardPort, { ...DISABLED, enabled: true, downKbps: 64 });

        const result = await new Promise<{
          status: number;
          bodyLength: number;
          firstByteAt: number;
          lastByteAt: number;
          dataEvents: number;
        }>((resolve, reject) => {
          const start = Date.now();
          let firstByteAt = -1;
          let dataEvents = 0;
          let bodyLength = 0;
          const req = http.request(
            {
              host: 'localhost',
              port: cli!.port,
              path: `http://127.0.0.1:${chunked.port}/`,
              method: 'GET',
            },
            (res) => {
              res.on('data', (chunk: Buffer) => {
                if (firstByteAt < 0) firstByteAt = Date.now();
                dataEvents++;
                bodyLength += chunk.length;
              });
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  bodyLength,
                  firstByteAt: firstByteAt - start,
                  lastByteAt: Date.now() - start,
                  dataEvents,
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        });

        expect(result.status).toBe(200);
        expect(result.bodyLength).toBe(chunkBytes * chunkCount);
        // The proxy relayed more than one distinct read from upstream —
        // never buffered into a single write — and the first byte reached
        // the client well before the last one: a "compute one total delay,
        // then dump the whole body" implementation would make these two
        // timestamps coincide (both ~4000ms) instead of ~1000ms apart from
        // ~4000ms.
        expect(result.dataEvents).toBeGreaterThan(1);
        expect(result.lastByteAt - result.firstByteAt).toBeGreaterThanOrEqual(2000);
        expect(result.lastByteAt).toBeGreaterThanOrEqual(3000);
      } finally {
        await chunked.close();
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
      const result = await runTsx(['src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--dump', 'bogus'], {
        cwd: REPO_ROOT,
        reject: false,
      });
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

  /**
   * `--proxy-auth` (issue #158). Everything here drives the real CLI over
   * real sockets from `127.0.0.1`/`localhost`, which is also the point of
   * the "loopback isn't exempt" cases: the credentials are demanded of every
   * client, including one on this very machine, because "same host" is not
   * the same thing as "same user".
   */
  describe('proxy authentication (issue #158)', () => {
    const CREDENTIALS = 'agent:hunter2';
    const AUTH_HEADER = `Basic ${Buffer.from(CREDENTIALS, 'utf8').toString('base64')}`;
    const WRONG_AUTH_HEADER = `Basic ${Buffer.from('agent:wrong-guess', 'utf8').toString('base64')}`;

    let headerEcho: Awaited<ReturnType<typeof startHeaderEchoServer>> | undefined;
    let marker: Awaited<ReturnType<typeof startMarkerEchoServer>> | undefined;
    let home: string | undefined;

    afterEach(async () => {
      await headerEcho?.close();
      await marker?.close();
      if (home) fs.rmSync(home, { recursive: true, force: true });
      headerEcho = undefined;
      marker = undefined;
      home = undefined;
    });

    /** Issues a request through the proxy and resolves with its status plus the `Proxy-Authenticate` challenge, which `requestThroughProxy` doesn't surface. */
    function requestWithChallenge(
      proxyPort: number,
      targetPort: number,
      headers?: http.OutgoingHttpHeaders,
    ): Promise<{ status: number; challenge: string | undefined }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: 'localhost',
            port: proxyPort,
            path: `http://127.0.0.1:${targetPort}/guarded`,
            method: 'GET',
            headers,
          },
          (res) => {
            res.resume();
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                challenge: res.headers['proxy-authenticate'] as string | undefined,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    it('answers an HTTP request with no credentials with 407 and a Basic challenge, without reaching upstream', async () => {
      headerEcho = await startHeaderEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);

      const result = await requestWithChallenge(cli.port, headerEcho.port);
      expect(result.status).toBe(407);
      expect(result.challenge).toBe('Basic realm="Detour"');
      expect(headerEcho.requestCount()).toBe(0);
    });

    it('answers an HTTP request with the wrong credentials with 407 too', async () => {
      headerEcho = await startHeaderEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);

      const result = await requestWithChallenge(cli.port, headerEcho.port, {
        'Proxy-Authorization': WRONG_AUTH_HEADER,
      });
      expect(result.status).toBe(407);
      expect(headerEcho.requestCount()).toBe(0);
    });

    it('proxies an HTTP request normally once the right credentials are presented', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);

      const result = await requestThroughProxy(cli.port, echo.port, '/hello', { 'Proxy-Authorization': AUTH_HEADER });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello', body: '' });
    });

    it('never forwards Proxy-Authorization to the upstream server', async () => {
      headerEcho = await startHeaderEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);

      const result = await requestThroughProxy(cli.port, headerEcho.port, '/guarded', {
        'Proxy-Authorization': AUTH_HEADER,
      });
      expect(result.status).toBe(200);
      const { headers } = JSON.parse(result.body) as { headers: Record<string, string> };
      expect(headers['proxy-authorization']).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(AUTH_HEADER.split(' ')[1]);
    });

    it('refuses a CONNECT with no credentials with 407, establishing no tunnel', async () => {
      marker = await startMarkerEchoServer('upstream');
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);

      await expect(connectTunnel(cli.port, '127.0.0.1', marker.port)).rejects.toThrow(/407/);
    });

    it('establishes a CONNECT tunnel once the right credentials are presented', async () => {
      marker = await startMarkerEchoServer('upstream');
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);
      // Intercept off, so the tunnel stays a raw byte-level passthrough the
      // marker echo server can answer — a MITM'd tunnel would try to
      // TLS-terminate it instead (see the passthrough tests above).
      await setIntercept(cli.dashboardPort, false);

      const socket = await connectTunnel(cli.port, '127.0.0.1', marker.port, {
        'Proxy-Authorization': AUTH_HEADER,
      });
      try {
        expect(await writeAndRead(socket, 'ping')).toBe('upstream:ping');
      } finally {
        socket.destroy();
      }
    });

    // A `ws://` upgrade is consumed by ProxyEngine's own WebSocketServer and
    // never reaches its request handler — without a gate of its own it would
    // be a way to relay traffic through an otherwise-authenticated proxy.
    it('rejects an unauthenticated ws:// upgrade through the proxy port', async () => {
      const wsEcho = await startWsEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);
      try {
        const socket = connectWebSocketThroughProxy(cli.port, wsEcho.port, '/echo');
        const error = await new Promise<Error>((resolve, reject) => {
          socket.on('error', resolve);
          socket.on('open', () => reject(new Error('the upgrade succeeded without credentials')));
        });
        expect(error.message).toContain('407');
      } finally {
        await wsEcho.close();
      }
    });

    // Authentication runs inside ProxyEngine, ahead of every handler
    // proxyServer.ts registers — so an unauthenticated client gets 407 even
    // for a host Block Hosts would otherwise have rejected first, which is
    // what "before Block Hosts, before Focus" actually looks like from
    // outside.
    it('answers 407 before Block Hosts (and the rest of the rule engine) ever runs', async () => {
      headerEcho = await startHeaderEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS]);
      await setBlockHosts(cli.dashboardPort, { hosts: ['127.0.0.1'], mode: 'forbidden' });

      const result = await requestWithChallenge(cli.port, headerEcho.port);
      expect(result.status).toBe(407);
      expect(result.challenge).toBe('Basic realm="Detour"');
    });

    it('keeps Proxy-Authorization out of the dashboard capture and out of --dump full output', async () => {
      echo = await startEchoServer();
      cli = await startDetourCli(['--proxy-auth', CREDENTIALS, '--dump', 'full']);
      const url = `http://127.0.0.1:${echo.port}/redacted`;
      const { exchange } = await waitForExchange(cli.dashboardPort, 'request', url);

      await requestThroughProxy(cli.port, echo.port, '/redacted', { 'Proxy-Authorization': AUTH_HEADER });

      const captured = await exchange;
      expect(captured.requestHeaders?.['proxy-authorization']).toBe('[REDACTED]');
      await waitForStdout(cli, /Request headers:/);
      expect(cli.stdout()).toContain('proxy-authorization: [REDACTED]');
      expect(cli.stdout()).not.toContain(AUTH_HEADER.split(' ')[1]);
    });

    it('warns at startup when --lan is on but no credentials are configured, and stops warning once they are', async () => {
      cli = await startDetourCli(['--lan']);
      expect(cli.stdout()).toContain('the proxy requires no credentials');
      expect(cli.stdout()).toContain('Proxy authentication: off');
      await cli.kill();

      cli = await startDetourCli(['--lan', '--proxy-auth', CREDENTIALS]);
      expect(cli.stdout()).not.toContain('the proxy requires no credentials');
      expect(cli.stdout()).toContain('Proxy authentication: required');
    });

    it('rejects a malformed --proxy-auth value without starting the proxy', async () => {
      const result = await runTsx(
        ['src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--proxy-auth', 'no-colon-here'],
        { cwd: REPO_ROOT, reject: false },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--proxy-auth must be in the form <user>:<pass>');
    });

    it('persists credentials via `detour config --proxy-auth` (hashed) and applies them to a later start', async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-proxy-auth-e2e-'));
      const env = { HOME: home, USERPROFILE: home };
      headerEcho = await startHeaderEchoServer();

      const configured = await runTsx(['src/cli.ts', 'config', '--proxy-auth', CREDENTIALS], {
        cwd: REPO_ROOT,
        reject: false,
        env,
      });
      expect(configured.exitCode).toBe(0);
      expect(configured.stdout).toContain('proxyAuth = on (user agent)');
      const stored = JSON.parse(fs.readFileSync(path.join(home, '.detour', 'config.json'), 'utf8')) as {
        proxyAuth: { username: string; passwordHash: string };
      };
      expect(stored.proxyAuth.username).toBe('agent');
      expect(JSON.stringify(stored)).not.toContain('hunter2');

      // No `--proxy-auth` on this start at all — it has to come from the
      // config file written just above.
      cli = await startDetourCli([], env);
      expect(cli.stdout()).toContain('Proxy authentication: required');
      expect((await requestWithChallenge(cli.port, headerEcho.port)).status).toBe(407);
      const allowed = await requestThroughProxy(cli.port, headerEcho.port, '/guarded', {
        'Proxy-Authorization': AUTH_HEADER,
      });
      expect(allowed.status).toBe(200);
    }, 40_000);
  });

  /**
   * Dashboard HTTPS (issue #159). `dashboardServer.rateLimit.test.ts` and
   * `dashboardServer.tls.test.ts` already cover the login rate limiting and
   * the TLS mechanics themselves against `startDashboardServer` directly —
   * these focus on what only a real spawned CLI process can prove: that
   * `--lan` actually flips the default, `--dashboard-tls off` actually
   * overrides it, and the cert a real client receives really is CA-signed
   * (not just "some TLS handshake succeeded").
   */
  describe('dashboard HTTPS (issue #159)', () => {
    /** The dashboard cert is CA-signed but the CA itself isn't in this test process's trust store — same as a real one until a user installs it. */
    function connectDashboardTls(port: number): Promise<tls.PeerCertificate> {
      return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: 'localhost', port, rejectUnauthorized: false }, () => {
          resolve(socket.getPeerCertificate());
          socket.destroy();
        });
        socket.on('error', reject);
      });
    }

    function connectDashboardWs(scheme: 'ws' | 'wss', port: number): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(`${scheme}://localhost:${port}/ws`, { rejectUnauthorized: false });
        const onMessage = (raw: WebSocket.RawData) => {
          const message = JSON.parse(raw.toString()) as { type: string };
          if (message.type !== 'backlog') return;
          socket.off('message', onMessage);
          resolve(message);
          socket.close();
        };
        socket.on('message', onMessage);
        socket.once('error', reject);
      });
    }

    it('defaults the dashboard to HTTPS once --lan is on, with a CA-signed cert and real traffic over it', async () => {
      const cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0', '--lan']);
      try {
        expect(cli.stdout()).toContain("Dashboard transport: HTTPS (Detour's CA)");
        expect(cli.stdout()).toMatch(new RegExp(`Dashboard → https://localhost:${cli.dashboardPort}\\b`));

        const cert = await connectDashboardTls(cli.dashboardPort!);
        expect(cert.subjectaltname).toMatch(/DNS:\s*localhost\b/);
        expect(cert.subjectaltname).toMatch(/IP Address:\s*127\.0\.0\.1\b/);

        const message = await connectDashboardWs('wss', cli.dashboardPort!);
        expect(message).toMatchObject({ type: 'backlog' });
      } finally {
        await cli.kill();
      }
    }, 20_000);

    it('stays on plain HTTP for a localhost-only dashboard (no --lan)', async () => {
      const cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0']);
      try {
        expect(cli.stdout()).toContain('Dashboard transport: HTTP (--dashboard-tls on to encrypt)');
        expect(cli.stdout()).toMatch(new RegExp(`Dashboard → http://localhost:${cli.dashboardPort}\\b`));
        const message = await connectDashboardWs('ws', cli.dashboardPort!);
        expect(message).toMatchObject({ type: 'backlog' });
      } finally {
        await cli.kill();
      }
    }, 20_000);

    it('--dashboard-tls off overrides the --lan default back to plain HTTP', async () => {
      const cli = await startDetourCliReady([
        '--port',
        '0',
        '--dashboard-port',
        '0',
        '--lan',
        '--dashboard-tls',
        'off',
      ]);
      try {
        expect(cli.stdout()).toContain('Dashboard transport: HTTP (--dashboard-tls on to encrypt)');
        expect(cli.stdout()).toMatch(new RegExp(`Dashboard → http://localhost:${cli.dashboardPort}\\b`));
        const message = await connectDashboardWs('ws', cli.dashboardPort!);
        expect(message).toMatchObject({ type: 'backlog' });
      } finally {
        await cli.kill();
      }
    }, 20_000);

    it('--dashboard-tls on forces HTTPS even without --lan', async () => {
      const cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0', '--dashboard-tls', 'on']);
      try {
        expect(cli.stdout()).toContain("Dashboard transport: HTTPS (Detour's CA)");
        const message = await connectDashboardWs('wss', cli.dashboardPort!);
        expect(message).toMatchObject({ type: 'backlog' });
      } finally {
        await cli.kill();
      }
    }, 20_000);
  });

  describe('upstream TLS verification and mTLS (issue #160)', () => {
    it('reports a specific "certificate verification failed" message (not a generic error) against an untrusted self-signed upstream by default', async () => {
      const upstream = await startHttpsUpstreamServer();
      cli = await startDetourCli();
      try {
        const url = `https://localhost:${upstream.port}/hello`;
        const { exchange } = await waitForExchange(cli.dashboardPort, 'response', url);
        await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello').catch(() => undefined);
        const result = await exchange;
        expect(result.error).toContain('Upstream certificate verification failed');
        expect(result.error).toMatch(/self.signed/i);
        expect(result.error).toContain('--upstream-ca');
        expect(result.error).toContain('--insecure-upstream');
      } finally {
        await upstream.close();
      }
    });

    it('--upstream-ca <path> reaches a private-CA-signed upstream, and the dashboard shows its real certificate', async () => {
      const { caPem, key, cert } = generateCaAndLeaf('localhost');
      const upstream = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
        const server = https.createServer({ key, cert }, (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, path: req.url }));
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('failed to bind'));
          resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
        });
      });
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const caPath = path.join(tmpDir, 'upstream-ca.pem');
      fs.writeFileSync(caPath, caPem);
      cli = await startDetourCli(['--upstream-ca', caPath]);
      try {
        const url = `https://localhost:${upstream.port}/hello`;
        const { exchange } = await waitForExchange(cli.dashboardPort, 'response', url);
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(200);

        const captured = await exchange;
        expect(captured.certificate?.authorized).toBe(true);
        expect(captured.certificate?.subject).toContain('localhost');
        expect(captured.certificate?.issuer).toContain('e2e-test-ca');
        expect(captured.certificate?.fingerprint256).toBeTruthy();
      } finally {
        await upstream.close();
      }
    });

    it('--insecure-upstream reaches a self-signed upstream, and flags the exchange as unverified', async () => {
      const upstream = await startHttpsUpstreamServer();
      cli = await startDetourCli(['--insecure-upstream']);
      try {
        // Waits for the banner's very last line rather than asserting on
        // `cli.stdout()` immediately: `startDetourCli`'s own ready-wait only
        // waits for the earlier "Dashboard →" line, and this warning is
        // printed several lines after it in the same (synchronous) banner —
        // late enough that it can still be in flight over the child
        // process's stdout pipe by the time this assertion would otherwise
        // run, an intermittent race unrelated to whether the flag actually
        // took effect.
        await waitForStdout(cli, /Press Ctrl\+C to stop\./);
        expect(cli.stdout()).toContain('upstream TLS certificate verification is OFF for this entire session');

        const url = `https://localhost:${upstream.port}/hello`;
        const { exchange } = await waitForExchange(cli.dashboardPort, 'response', url);
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(200);

        const captured = await exchange;
        expect(captured.certificate?.authorized).toBe(false);
        expect(captured.certificate?.authorizationError).toBeTruthy();
      } finally {
        await upstream.close();
      }
    });

    it('--client-cert/--client-key present a client certificate an mTLS-requiring upstream accepts, where a plain --insecure-upstream request is rejected', async () => {
      const server = generateCaAndLeaf('localhost');
      const client = generateCaAndLeaf('e2e-client');
      const upstream = await startMtlsUpstreamServer({ key: server.key, cert: server.cert }, client.caPem);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const clientCertPath = path.join(tmpDir, 'client.crt');
      const clientKeyPath = path.join(tmpDir, 'client.key');
      fs.writeFileSync(clientCertPath, client.cert);
      fs.writeFileSync(clientKeyPath, client.key);
      // `--insecure-upstream` here is only about trusting the *server's* own
      // cert (self-signed from this test's perspective) — orthogonal to
      // mTLS, which is the server separately demanding a client cert.
      cli = await startDetourCli([
        '--insecure-upstream',
        '--client-cert',
        clientCertPath,
        '--client-key',
        clientKeyPath,
      ]);
      try {
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(200);
      } finally {
        await upstream.close();
      }
    });

    it('rejects the mTLS-requiring upstream without --client-cert (proving the previous test actually needed it)', async () => {
      const server = generateCaAndLeaf('localhost');
      const client = generateCaAndLeaf('e2e-client');
      const upstream = await startMtlsUpstreamServer({ key: server.key, cert: server.cert }, client.caPem);
      cli = await startDetourCli(['--insecure-upstream']);
      try {
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(504);
        expect(result.body).toContain('certificate required');
      } finally {
        await upstream.close();
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

    it('rewrites a response body over HTTP/2 without leaving a stale content-length behind (issue #93 regression)', async () => {
      // A `rewrite` rule that changes the response body's byte count leaves
      // upstream's original `content-length` wrong. Over HTTP/1.1 that's
      // masked by re-framing as `transfer-encoding: chunked`, but HTTP/2 has
      // no such header — it still carries `content-length` as an ordinary
      // header, and RFC 9113 §8.1.1 makes a response whose DATA frames don't
      // match it malformed, which Node's own http2 client enforces by
      // tearing the stream down. Before the fix, this rule (rewriting the
      // JSON response into a much longer body) reproduced exactly that: the
      // client never got past the stale, too-short content-length.
      const upstream = await startHttpsUpstreamServer();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
      const rewrittenBody = 'x'.repeat(500);
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(
        rulesPath,
        JSON.stringify({
          rules: [
            {
              name: 'e2e-h2-rewrite-response-body',
              match: { url: `https://localhost:${upstream.port}/*` },
              action: { type: 'rewrite', response: { body: { set: rewrittenBody } } },
            },
          ],
        }),
      );
      cli = await startDetourCli(['--rules', rulesPath], insecureUpstreamEnv);
      let session: http2.ClientHttp2Session | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      try {
        const connected = await connectHttp2ThroughProxy(cli.port, 'localhost', upstream.port, cli.caCertPath);
        session = connected.session;
        tlsSocket = connected.tlsSocket;
        expect(connected.tlsSocket.alpnProtocol).toBe('h2');

        const result = await h2Get(session, `localhost:${upstream.port}`, '/hello');
        expect(result.status).toBe(200);
        expect(result.body).toBe(rewrittenBody);
      } finally {
        session?.close();
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

    // ProxyEngine's HTTP/2-specific behavior (see `clientIsHttp2` in
    // engine/proxyEngine.ts) is all gated on the client having negotiated
    // HTTP/2 — this proves the original HTTP/1.1 HTTPS
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

    it("doesn't crash the whole process when the client abruptly disconnects mid-request over HTTP/2 (regression)", async () => {
      // Never responds — the point is for this request to still be "in
      // flight" (no response sent to the client yet) when the test yanks
      // the client's connection out from under it below. Tracks every
      // connected socket and destroys them on `close()`: `server.close()`
      // alone waits for open connections to finish on their own, which
      // this test's own proxy↔upstream connection never does by design —
      // left untracked, `close()` would hang instead of ever resolving.
      const slowUpstream = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
        const { key, cert } = generateSelfSignedCert('127.0.0.1');
        const server = https.createServer({ key, cert }, (req) => req.resume());
        // `Duplex`, not `net.Socket`/`tls.TLSSocket` — that's the type
        // @types/node itself declares for `https.Server`'s own
        // `'connection'` event, even though a `tls.TLSSocket` (a `net.Socket`
        // subclass) is what's actually emitted.
        const sockets = new Set<import('node:stream').Duplex>();
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('failed to bind'));
          resolve({
            port: address.port,
            close: () =>
              new Promise((res) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => res());
              }),
          });
        });
      });
      cli = await startDetourCli([], insecureUpstreamEnv);
      let session: http2.ClientHttp2Session | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      try {
        const connected = await connectHttp2ThroughProxy(cli.port, 'localhost', slowUpstream.port, cli.caCertPath);
        session = connected.session;
        tlsSocket = connected.tlsSocket;
        // Destroying the underlying TLS socket below can itself surface as
        // an `error` event on the session wrapping it — an EventEmitter
        // `error` with no listener throws, which would crash this test
        // process for an unrelated reason (a test-harness artifact of how
        // the disconnect was simulated, not anything this test is actually
        // checking).
        session.on('error', () => {});

        const req = session.request({
          ':path': '/slow',
          ':method': 'POST',
          ':authority': `localhost:${slowUpstream.port}`,
        });
        req.write('partial-body'); // starts the request but deliberately never finishes it
        req.on('error', () => {}); // this request itself erroring out below is expected, not the point of this test

        // Give Detour a moment to actually forward the partial request
        // upstream before abruptly disconnecting.
        await new Promise((resolve) => setTimeout(resolve, 200));

        // A dropped connection (network blip, a browser tab closed
        // mid-upload, ...) rather than a clean HTTP/2 stream close —
        // leaves Detour's own response stream to this client destroyed
        // before it ever got a response, the state that used to make
        // ProxyEngine's `emitError` throw ERR_HTTP2_INVALID_STREAM
        // uncaught (ProxyEngine.emitError`'s own try/catch is the fix).
        tlsSocket.destroy();

        // Give the (pre-fix) uncaught exception a moment to actually crash
        // the process, if it's going to.
        await new Promise((resolve) => setTimeout(resolve, 500));

        // The regression was the *whole* `detour start` process going
        // down over one broken connection, not just that connection
        // failing — a brand new, otherwise-unrelated request through the
        // same still-running process is the clearest proof it survived.
        const upstream2 = await startHttpsUpstreamServer();
        try {
          const connected2 = await connectHttp2ThroughProxy(cli.port, 'localhost', upstream2.port, cli.caCertPath);
          try {
            const result = await h2Get(connected2.session, `localhost:${upstream2.port}`, '/hello');
            expect(result.status).toBe(200);
          } finally {
            connected2.session.close();
            connected2.tlsSocket.destroy();
          }
        } finally {
          await upstream2.close();
        }
      } finally {
        session?.close();
        tlsSocket?.destroy();
        await slowUpstream.close();
      }
    }, 15_000);
  });

  describe('upstream HTTP/2 (issue #166)', () => {
    const insecureUpstreamEnv = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };

    it('ALPN-negotiates HTTP/2 with a real h2-only upstream server (h1 client) and reports upstreamProtocol', async () => {
      const upstream = await startHttp2UpstreamServer();
      cli = await startDetourCli([], insecureUpstreamEnv);
      try {
        const { exchange } = await waitForExchange(
          cli.dashboardPort,
          'response',
          `https://localhost:${upstream.port}/hello`,
        );
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello' });
        expect((await exchange).upstreamProtocol).toBe('HTTP/2');
      } finally {
        await upstream.close();
      }
    });

    it('an h2 client through an h2-only upstream stays h2 on both legs', async () => {
      const upstream = await startHttp2UpstreamServer();
      cli = await startDetourCli([], insecureUpstreamEnv);
      let session: http2.ClientHttp2Session | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      try {
        const { exchange } = await waitForExchange(
          cli.dashboardPort,
          'response',
          `https://localhost:${upstream.port}/hello`,
        );
        const connected = await connectHttp2ThroughProxy(cli.port, 'localhost', upstream.port, cli.caCertPath);
        session = connected.session;
        tlsSocket = connected.tlsSocket;
        expect(connected.tlsSocket.alpnProtocol).toBe('h2');

        const result = await h2Get(session, `localhost:${upstream.port}`, '/hello');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello' });
        expect((await exchange).upstreamProtocol).toBe('HTTP/2');
      } finally {
        session?.close();
        tlsSocket?.destroy();
        await upstream.close();
      }
    });

    it('multiplexes a second request to the same h2 upstream host onto the already-established session', async () => {
      const upstream = await startHttp2UpstreamServer();
      cli = await startDetourCli([], insecureUpstreamEnv);
      try {
        const first = await waitForExchange(cli.dashboardPort, 'response', `https://localhost:${upstream.port}/one`);
        await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/one');
        expect((await first.exchange).upstreamProtocol).toBe('HTTP/2');

        const second = await waitForExchange(cli.dashboardPort, 'response', `https://localhost:${upstream.port}/two`);
        await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/two');
        expect((await second.exchange).upstreamProtocol).toBe('HTTP/2');
      } finally {
        await upstream.close();
      }
    });

    it('--no-http2-upstream pins the proxy→upstream leg to HTTP/1.1 even though the upstream offers h2', async () => {
      // A dual-protocol upstream (h1 *and* h2 via ALPN), not the h2-only
      // one above: proves specifically that `--no-http2-upstream` skips the
      // ALPN probe (this server would happily negotiate h2 if it were
      // offered), rather than merely that an h2-only server was
      // unreachable for some other reason.
      const upstream = await startDualProtocolUpstreamServer();
      cli = await startDetourCli(['--no-http2-upstream'], insecureUpstreamEnv);
      try {
        const { exchange } = await waitForExchange(
          cli.dashboardPort,
          'response',
          `https://localhost:${upstream.port}/hello`,
        );
        const result = await httpsRequestThroughProxy(cli.port, cli.caCertPath, upstream.port, '/hello');
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ method: 'GET', path: '/hello' });
        expect((await exchange).upstreamProtocol).toBe('HTTP/1.1');
      } finally {
        await upstream.close();
      }
    });

    it('forwards an h2 upstream response’s gRPC-style trailers on to an h2 client (issue #166’s gRPC acceptance criterion)', async () => {
      const upstream = await startHttp2UpstreamServer(() => ({ 'grpc-status': '0', 'grpc-message': 'OK' }));
      cli = await startDetourCli([], insecureUpstreamEnv);
      let session: http2.ClientHttp2Session | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      try {
        const connected = await connectHttp2ThroughProxy(cli.port, 'localhost', upstream.port, cli.caCertPath);
        session = connected.session;
        tlsSocket = connected.tlsSocket;

        const trailers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
          const req = session!.request({
            ':path': '/hello',
            ':method': 'GET',
            ':authority': `localhost:${upstream.port}`,
            te: 'trailers',
          });
          req.on('trailers', resolve);
          req.on('error', reject);
          req.resume();
          req.end();
        });
        expect(trailers['grpc-status']).toBe('0');
        expect(trailers['grpc-message']).toBe('OK');
      } finally {
        session?.close();
        tlsSocket?.destroy();
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
        const result = await runTsx(
          ['src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--proto', protoPath],
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

/**
 * Finds a currently-unused TCP port by binding to port 0 and reading back
 * what the OS assigned, then releasing it — needed for the tests below that
 * (unlike the rest of this file) can't just use `--port 0` themselves: "Fail
 * on Running"/`--detach`/`status`/`stop` are keyed by a stable port (see
 * `runStateStore.ts`), which an ephemeral one by definition isn't. Same
 * small race any "find a free port, then use it" approach has — acceptable
 * here, same as `assertPortAvailable`'s own doc comment reasons about.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to find a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawns `detour start` and waits for its `DETOUR_READY` line (issue #20)
 * instead of `startDetourCli`'s startup-banner scraping — the more direct
 * signal, and the one a real CI script would actually watch for. Exposes
 * `exitCode()` (live, `null` while running) so `--exit-on-idle` tests can
 * observe the process exiting on its own rather than being killed.
 */
async function startDetourCliReady(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{
  proxyPort: number;
  dashboardPort: number | undefined;
  pid: number;
  stdout: () => string;
  stderr: () => string;
  exitCode: () => number | null;
  kill: () => Promise<void>;
}> {
  const subprocess = runTsx(['src/cli.ts', 'start', ...args], {
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
  // execa's typed subprocess (unlike Node's own ChildProcess) doesn't expose
  // a live `.exitCode` property to poll — track it ourselves via the
  // (never-rejecting, since `reject: false`) result promise settling.
  let exitCode: number | null = null;
  void subprocess.then((result) => {
    exitCode = result.exitCode ?? null;
  });

  const start = Date.now();
  while (!/DETOUR_READY/.test(stdout)) {
    if (exitCode !== null) {
      throw new Error(
        `detour start exited before becoming ready (code ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
    if (Date.now() - start > 15_000) {
      subprocess.kill();
      throw new Error(`detour start never printed DETOUR_READY.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const match = stdout.match(/DETOUR_READY proxyPort=(\d+)(?: dashboardPort=(\d+))? pid=(\d+)/);
  if (!match) throw new Error(`could not parse DETOUR_READY line from stdout: ${stdout}`);

  return {
    proxyPort: Number(match[1]),
    dashboardPort: match[2] ? Number(match[2]) : undefined,
    pid: Number(match[3]),
    stdout: () => stdout,
    stderr: () => stderr,
    exitCode: () => exitCode,
    kill: async () => {
      subprocess.kill('SIGTERM');
      await subprocess.catch(() => {});
    },
  };
}

describe('detour daemon mode / headless / idle / fail-on-running / cert export (issue #20, CLI end-to-end)', () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>> | undefined;
  let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await cli?.kill();
    await echo?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    cli = undefined;
    echo = undefined;
    tmpDir = undefined;
  });

  it('prints a DETOUR_READY line once the proxy and dashboard are listening', async () => {
    cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0']);
    expect(cli.stdout()).toMatch(/DETOUR_READY proxyPort=\d+ dashboardPort=\d+ pid=\d+/);
  });

  describe('--headless', () => {
    it('skips starting the dashboard entirely while the proxy keeps working', async () => {
      echo = await startEchoServer();
      cli = await startDetourCliReady(['--port', '0', '--headless']);

      expect(cli.dashboardPort).toBeUndefined();
      expect(cli.stdout()).toContain('Dashboard → disabled (--headless)');
      expect(cli.stdout()).toMatch(/DETOUR_READY proxyPort=\d+ pid=\d+/);
      expect(cli.stdout()).not.toContain('dashboardPort=');

      const result = await requestThroughProxy(cli.proxyPort, echo.port, '/hello');
      expect(result.status).toBe(200);
    });
  });

  describe('--exit-on-idle', () => {
    it('exits on its own once the idle window elapses with no traffic', async () => {
      cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0', '--exit-on-idle', '500']);

      const start = Date.now();
      while (cli.exitCode() === null) {
        if (Date.now() - start > 10_000) throw new Error(`process never exited on its own.\nstdout: ${cli.stdout()}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(cli.exitCode()).toBe(0);
      expect(cli.stdout()).toContain('No activity for 500ms');
    });

    it('rejects a non-positive value without starting the proxy', async () => {
      const result = await runTsx(
        ['src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--exit-on-idle', '0'],
        { cwd: REPO_ROOT, reject: false },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--exit-on-idle must be a positive integer');
    });

    it('does not exit while a request is still in flight, even past the idle window', async () => {
      // Responds only after `delayMs` — long enough to outlast --exit-on-idle
      // below, so the idle timer would (incorrectly) fire mid-request if the
      // watcher only rearmed on `response` instead of tracking in-flight
      // requests (see idleWatcher.ts's doc comment).
      const delayMs = 900;
      const slow = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
        const server = http.createServer((_req, res) => {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('done');
          }, delayMs);
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('failed to bind slow server'));
            return;
          }
          resolve({ port: address.port, close: () => new Promise((res) => server.close(() => res())) });
        });
      });

      try {
        cli = await startDetourCliReady(['--port', '0', '--dashboard-port', '0', '--exit-on-idle', '300']);
        const requestPromise = requestThroughProxy(cli.proxyPort, slow.port, '/slow');

        // Past the 300ms idle window, but the request above is still in
        // flight (the slow server won't respond for `delayMs`) — the
        // process must still be alive here.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(cli.exitCode()).toBeNull();

        const result = await requestPromise;
        expect(result.status).toBe(200);

        // Now genuinely idle — it should exit on its own shortly after.
        const start = Date.now();
        while (cli.exitCode() === null) {
          if (Date.now() - start > 10_000)
            throw new Error(`process never exited after going idle.\nstdout: ${cli.stdout()}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(cli.exitCode()).toBe(0);
      } finally {
        await slow.close();
      }
    });
  });

  describe('--fail-on-running', () => {
    it('exits with code 3 when another instance is already tracked as running on the same --port', async () => {
      const port = await findFreePort();
      cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0', '--fail-on-running']);

      const second = await runTsx(
        ['src/cli.ts', 'start', '--port', String(port), '--dashboard-port', '0', '--fail-on-running'],
        { cwd: REPO_ROOT, reject: false },
      );
      expect(second.exitCode).toBe(3);
      expect(second.stderr).toContain('already running');
      expect(second.stderr).toContain(`port ${port}`);
    });

    it('rejects being combined with an ephemeral --port 0', async () => {
      const result = await runTsx(
        ['src/cli.ts', 'start', '--port', '0', '--dashboard-port', '0', '--fail-on-running'],
        { cwd: REPO_ROOT, reject: false },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--fail-on-running requires an explicit --port');
    });

    it('reserves the port atomically: exactly one of two truly concurrent starts wins the race', async () => {
      // Regression test for a TOCTOU race (found in local review before this
      // ever reached a real reviewer): two `--fail-on-running` starts
      // launched close enough together could previously both pass the
      // early `findLiveRunState` check (nothing tracked yet) and both
      // proceed, since the actual run-state write happened much later —
      // reserveRunState (an atomic exclusive-create) is what closes that
      // window. Launches both processes at once (not sequentially, unlike
      // the test above) so they genuinely race for the same reservation.
      const port = await findFreePort();
      const spawnArgs = ['src/cli.ts', 'start', '--port', String(port), '--dashboard-port', '0', '--fail-on-running'];
      const procA = runTsx(spawnArgs, { cwd: REPO_ROOT, reject: false });
      const procB = runTsx(spawnArgs, { cwd: REPO_ROOT, reject: false });

      let resultA: Awaited<typeof procA> | undefined;
      let resultB: Awaited<typeof procB> | undefined;
      void procA.then((r) => {
        resultA = r;
      });
      void procB.then((r) => {
        resultB = r;
      });

      let stdoutA = '';
      procA.stdout?.on('data', (c: Buffer) => {
        stdoutA += c.toString();
      });
      let stdoutB = '';
      procB.stdout?.on('data', (c: Buffer) => {
        stdoutB += c.toString();
      });
      let stderrA = '';
      procA.stderr?.on('data', (c: Buffer) => {
        stderrA += c.toString();
      });
      let stderrB = '';
      procB.stderr?.on('data', (c: Buffer) => {
        stderrB += c.toString();
      });

      try {
        // The loser exits almost immediately (CliExitError(3), well before
        // ever binding a port); the winner is a real, long-running `detour
        // start` that only exits once killed below — so "one of the two
        // execa promises settles" is exactly the signal that exactly one
        // process lost the race, without waiting on the winner to exit.
        const start = Date.now();
        while (!resultA && !resultB) {
          if (Date.now() - start > 15_000) {
            throw new Error(
              `neither concurrent start exited within 15s — expected exactly one to lose the reservation race.\nstdout A: ${stdoutA}\nstdout B: ${stdoutB}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const [loserResult, loserStderr, winnerStdoutRef] = resultA
          ? [resultA, stderrA, () => stdoutB]
          : [resultB!, stderrB, () => stdoutA];

        expect(loserResult.exitCode).toBe(3);
        expect(loserStderr).toContain('already running');
        expect(loserStderr).toContain(`port ${port}`);

        // The winner should be a genuine, successful start — not also a
        // reservation failure that happened to resolve slower.
        await waitForStdout({ stdout: winnerStdoutRef }, /DETOUR_READY/);
      } finally {
        procA.kill('SIGTERM');
        procB.kill('SIGTERM');
        await Promise.all([procA.catch(() => {}), procB.catch(() => {})]);
      }
    }, 30_000);
  });

  describe('--detach / detour status / detour stop', () => {
    it('starts detached, is visible via status, and can be stopped', async () => {
      const port = await findFreePort();
      const runDetourStop = () =>
        runTsx(['src/cli.ts', 'stop', '--port', String(port)], { cwd: REPO_ROOT, reject: false });

      try {
        const detach = await runTsx(
          ['src/cli.ts', 'start', '--port', String(port), '--dashboard-port', '0', '--detach'],
          { cwd: REPO_ROOT, reject: false, timeout: 20_000 },
        );
        expect(detach.exitCode).toBe(0);
        expect(detach.stdout).toContain('started in the background');
        expect(detach.stdout).toContain(`detour stop --port ${port}`);

        const status = await runTsx(['src/cli.ts', 'status', '--port', String(port)], {
          cwd: REPO_ROOT,
          reject: false,
        });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain(`running on port ${port}`);
        expect(status.stdout).toContain('detached');

        const stop = await runDetourStop();
        expect(stop.exitCode).toBe(0);
        expect(stop.stdout).toContain('Stopped detour');

        const statusAfterStop = await runTsx(['src/cli.ts', 'status', '--port', String(port)], {
          cwd: REPO_ROOT,
          reject: false,
        });
        expect(statusAfterStop.exitCode).toBe(1);
        expect(statusAfterStop.stdout).toContain('not running');
      } finally {
        // Best-effort: cleans up the daemon if an assertion above threw before `stop` ran.
        await runDetourStop().catch(() => {});
      }
    }, 30_000);

    it('rejects being combined with an ephemeral --port 0', async () => {
      const result = await runTsx(['src/cli.ts', 'start', '--port', '0', '--detach'], {
        cwd: REPO_ROOT,
        reject: false,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--detach requires an explicit --port');
    });
  });

  describe('detour config --default-detach', () => {
    /** Points `~/.detour/config.json` at a scratch dir for the duration of one test, so persisting `defaultDetach` here can never leak into the developer's real `~/.detour/config.json` (or between these tests). */
    function withTempHome(): { home: string; env: NodeJS.ProcessEnv } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-config-e2e-'));
      // HOME (POSIX) and USERPROFILE (Windows) — os.homedir() reads whichever applies.
      return { home, env: { HOME: home, USERPROFILE: home } };
    }

    it.each([
      ['defaultDetach', 'false'],
      ['lanAccess', 'false'],
      ['dashboardPassword', 'off'],
    ])('reports %s = %s when nothing has been configured', async (key, expected) => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'config'], { cwd: REPO_ROOT, reject: false, env });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`${key} = ${expected}`);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('persists --default-detach on to ~/.detour/config.json', async () => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'config', '--default-detach', 'on'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('defaultDetach = true');
        expect(JSON.parse(fs.readFileSync(path.join(home, '.detour', 'config.json'), 'utf8'))).toEqual({
          defaultDetach: true,
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('makes `detour start` run detached with no --detach flag once defaultDetach is on', async () => {
      const { home, env } = withTempHome();
      const port = await findFreePort();
      const runDetourStop = () =>
        runTsx(['src/cli.ts', 'stop', '--port', String(port)], { cwd: REPO_ROOT, reject: false, env });
      try {
        await runTsx(['src/cli.ts', 'config', '--default-detach', 'on'], { cwd: REPO_ROOT, reject: false, env });

        const start = await runTsx(['src/cli.ts', 'start', '--port', String(port), '--dashboard-port', '0'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
          timeout: 20_000,
        });
        expect(start.exitCode).toBe(0);
        expect(start.stdout).toContain('started in the background');

        const status = await runTsx(['src/cli.ts', 'status', '--port', String(port)], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });
        expect(status.stdout).toContain('detached');
      } finally {
        await runDetourStop().catch(() => {});
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 30_000);

    it('--foreground overrides defaultDetach back to foreground for one run', async () => {
      const { home, env } = withTempHome();
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        await runTsx(['src/cli.ts', 'config', '--default-detach', 'on'], { cwd: REPO_ROOT, reject: false, env });

        // A foreground run reports readiness itself (no daemon handshake) and keeps running until killed —
        // both true only if --foreground actually won out over the config's defaultDetach: true.
        cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0', '--foreground'], env);
        expect(cli.stdout()).toContain('DETOUR_READY');
      } finally {
        await cli?.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 20_000);

    it('persists --lan on to ~/.detour/config.json', async () => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'config', '--lan', 'on'], { cwd: REPO_ROOT, reject: false, env });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('lanAccess = true');
        expect(JSON.parse(fs.readFileSync(path.join(home, '.detour', 'config.json'), 'utf8'))).toEqual({
          lanAccess: true,
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('the proxy is reachable on the network with no --lan at all — it always binds to every interface, --headless included', async () => {
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        cli = await startDetourCliReady(['--port', String(port), '--headless']);
        // No dashboard at all here (--headless) and no --lan/lanAccess either —
        // the proxy's own LAN reachability doesn't depend on either.
        expect(cli.stdout()).not.toContain('Dashboard bound to every network interface');
        // Only asserted when this machine actually has a non-internal interface (true for
        // every CI runner and real dev machine) — `localhost` alone would be useless to
        // whoever's supposed to reach this from elsewhere on the network.
        // Matches lanAddresses()'s own selection exactly (IPv4, non-internal) — an IPv6-only
        // host has a non-internal interface but no non-internal IPv4 one, so the banner
        // prints no address at all and this guard must not fire there either.
        if (
          Object.values(os.networkInterfaces()).some((iface) => iface?.some((i) => i.family === 'IPv4' && !i.internal))
        ) {
          expect(cli.stdout()).toMatch(/Reachable on your network at:\n {2}Proxy\s+→ http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
        }
      } finally {
        await cli?.kill();
      }
    }, 20_000);

    it('--lan on `start` additionally warns that the *dashboard* bound to every network interface, and lists a reachable Dashboard URL alongside the Proxy one', async () => {
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0', '--lan']);
        expect(cli.stdout()).toContain('Dashboard bound to every network interface');
        if (
          Object.values(os.networkInterfaces()).some((iface) => iface?.some((i) => i.family === 'IPv4' && !i.internal))
        ) {
          // The dashboard's own scheme is https:// by default under --lan
          // now (issue #159) — the proxy's stays http:// either way (it has
          // no TLS listener of its own; `--proxy-auth` is its equivalent).
          expect(cli.stdout()).toMatch(
            /Reachable on your network at:\n {2}Proxy\s+→ http:\/\/\d+\.\d+\.\d+\.\d+:\d+\n {2}Dashboard → https:\/\/\d+\.\d+\.\d+\.\d+:\d+/,
          );
        }
      } finally {
        await cli?.kill();
      }
    }, 20_000);

    it('--no-lan overrides a config-enabled lanAccess back to localhost-only for one run — for the dashboard only, never the proxy', async () => {
      const { home, env } = withTempHome();
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        await runTsx(['src/cli.ts', 'config', '--lan', 'on'], { cwd: REPO_ROOT, reject: false, env });

        cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0', '--no-lan'], env);
        expect(cli.stdout()).not.toContain('Dashboard bound to every network interface');
        // The proxy line is still there regardless — --no-lan never touches it.
        expect(cli.stdout()).toContain('Proxy     →');
      } finally {
        await cli?.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 20_000);

    it('makes the dashboard bind 0.0.0.0 with no --lan flag once lanAccess is on', async () => {
      const { home, env } = withTempHome();
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        await runTsx(['src/cli.ts', 'config', '--lan', 'on'], { cwd: REPO_ROOT, reject: false, env });

        // Neither --lan nor --no-lan passed — this is the tri-state resolution
        // (`options.lan ?? config.lanAccess`) most likely to regress silently,
        // since commander's own defaulting could just as easily turn "flag
        // omitted" into `false` instead of `undefined`.
        cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0'], env);
        expect(cli.stdout()).toContain('Dashboard bound to every network interface');
      } finally {
        await cli?.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 20_000);

    it('rejects --foreground combined with --detach rather than silently preferring one', async () => {
      const port = await findFreePort();
      const result = await runTsx(
        ['src/cli.ts', 'start', '--port', String(port), '--dashboard-port', '0', '--foreground', '--detach'],
        {
          cwd: REPO_ROOT,
          reject: false,
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--foreground and --detach cannot be combined');
    });

    it('persists --dashboard-password <value> as a hash, never the plaintext', async () => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'config', '--dashboard-password', 'hunter2'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('dashboardPassword = on');
        expect(result.stdout).not.toContain('hunter2');
        const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.detour', 'config.json'), 'utf8'));
        expect(onDisk.dashboardPasswordHash).toBeTruthy();
        expect(onDisk.dashboardPasswordHash).not.toContain('hunter2');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects an empty --dashboard-password rather than silently setting a trivially-guessable one', async () => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'config', '--dashboard-password', ''], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('--dashboard-password must not be empty');
        expect(fs.existsSync(path.join(home, '.detour', 'config.json'))).toBe(false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('--dashboard-password off clears a previously-set password', async () => {
      const { home, env } = withTempHome();
      try {
        await runTsx(['src/cli.ts', 'config', '--dashboard-password', 'hunter2'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });

        const result = await runTsx(['src/cli.ts', 'config', '--dashboard-password', 'off'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('dashboardPassword = off');
        const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.detour', 'config.json'), 'utf8'));
        expect(onDisk.dashboardPasswordHash).toBeNull();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('`detour start` banner reports whether a dashboard password is required', async () => {
      const { home, env } = withTempHome();
      const port = await findFreePort();
      let cli: Awaited<ReturnType<typeof startDetourCliReady>> | undefined;
      try {
        await runTsx(['src/cli.ts', 'config', '--dashboard-password', 'hunter2'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
        });

        cli = await startDetourCliReady(['--port', String(port), '--dashboard-port', '0'], env);
        expect(cli.stdout()).toContain('Dashboard password: required');
      } finally {
        await cli?.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 20_000);
  });

  describe('detour cert export', () => {
    it('prints the CA certificate PEM to stdout when no path is given', async () => {
      const result = await runTsx(['src/cli.ts', 'cert', 'export'], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-----BEGIN CERTIFICATE-----');
      expect(result.stdout).toContain('-----END CERTIFICATE-----');
    });

    it('writes the CA certificate to the given path, creating parent directories as needed', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-cert-export-'));
      const dest = path.join(tmpDir, 'nested', 'ca.pem');

      const result = await runTsx(['src/cli.ts', 'cert', 'export', dest], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Exported CA certificate to ${dest}`);
      expect(fs.readFileSync(dest, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
    });
  });

  describe('detour doctor / cleanup and CA cert existence (issue #65)', () => {
    /** Isolated `~/.detour` with nothing in it yet — the "first run ever, `detour setup` hasn't happened" state these tests exercise. */
    function withTempHome(): { home: string; env: NodeJS.ProcessEnv } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-setup-cert-e2e-'));
      return { home, env: { HOME: home, USERPROFILE: home } };
    }

    it('doctor exits non-zero when no CA certificate has been generated yet, even for a target whose own check never verifies cert trust', async () => {
      const { home, env } = withTempHome();
      try {
        // windows: manual-only, so this isolates the cert-existence check
        // itself from any of the automated targets' own pass/fail logic.
        const result = await runTsx(['src/cli.ts', 'doctor', '--target', 'windows'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
          timeout: 15_000,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain('No CA certificate generated yet');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('cleanup does not fail just because no CA certificate has been generated yet (it only reverts proxy config)', async () => {
      const { home, env } = withTempHome();
      try {
        const result = await runTsx(['src/cli.ts', 'cleanup', '--target', 'windows'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
          timeout: 15_000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No CA certificate generated yet');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("doctor suppresses its manual-verification summary when a step was skipped (e.g. an explicit --target on the wrong host) — skipped means some checks never ran at all, not merely 'ran but needs a look'", async () => {
      const { home, env } = withTempHome();
      try {
        // windows's own automation is manual-only, so `setup` here just
        // issues the CA cert as a side effect without touching anything else.
        await runTsx(['src/cli.ts', 'setup', '--target', 'windows'], {
          cwd: REPO_ROOT,
          reject: false,
          env,
          timeout: 15_000,
        });

        // Whichever of mac/linux this test isn't already running on.
        const wrongHostTarget = process.platform === 'darwin' ? 'linux' : 'mac';
        const result = await runTsx(['src/cli.ts', 'doctor', '--target', wrongHostTarget], {
          cwd: REPO_ROOT,
          reject: false,
          env,
          timeout: 15_000,
        });
        expect(result.stdout).toContain(`can't run automated doctor for ${wrongHostTarget}`);
        expect(result.stdout).not.toContain('need manual verification');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('detour test (issue #148, CLI end-to-end)', () => {
  /** Writes a `detour.test.json`-shaped assertions file to a scratch directory, returning its path. */
  function writeAssertionsFile(tmpDir: string, testFile: unknown): string {
    const assertionsPath = path.join(tmpDir, 'detour.test.json');
    fs.writeFileSync(assertionsPath, JSON.stringify(testFile));
    return assertionsPath;
  }

  /**
   * Writes a small standalone Node script that reads `HTTP_PROXY` (set by
   * `detour test` on the child it spawns) and issues one proxied GET for
   * `upstreamPath` against the given upstream port, in the classic explicit
   * forward-proxy shape (an absolute-URL request line) — the same style
   * `requestThroughProxy` above uses from inside this test process, just
   * reproduced here as source text since this script runs in its own child
   * process instead.
   */
  function writeProxiedGetScript(
    tmpDir: string,
    upstreamPort: number,
    upstreamPath: string,
    headers: Record<string, string>,
  ): string {
    const scriptPath = path.join(tmpDir, 'client.js');
    fs.writeFileSync(
      scriptPath,
      `
      const http = require('http');
      const proxyUrl = new URL(process.env.HTTP_PROXY);
      const req = http.request(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          path: 'http://127.0.0.1:${upstreamPort}${upstreamPath}',
          method: 'GET',
          headers: ${JSON.stringify(headers)},
        },
        (res) => {
          res.resume();
          res.on('end', () => process.exit(0));
        },
      );
      req.on('error', (err) => { console.error(err); process.exit(1); });
      req.end();
      `,
    );
    return scriptPath;
  }

  it('passes a `headerPresent` assertion when the proxied request under test actually carried the header', async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, {
        assertions: [
          {
            type: 'headerPresent',
            name: 'orders API requires auth',
            match: { url: `http://127.0.0.1:${upstream.port}/*` },
            header: 'Authorization',
          },
        ],
      });
      const scriptPath = writeProxiedGetScript(tmpDir, upstream.port, '/orders', { Authorization: 'Bearer token' });

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, scriptPath],
        { cwd: REPO_ROOT, reject: false, timeout: 15_000 },
      );

      expect(result.stdout).toContain('✔ orders API requires auth');
      expect(result.stdout).toContain('1/1 assertion(s) passed');
      expect(result.exitCode).toBe(0);
    } finally {
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails a `headerPresent` assertion (nonzero exit) when the proxied request under test was missing the header', async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, {
        assertions: [
          {
            type: 'headerPresent',
            name: 'orders API requires auth',
            match: { url: `http://127.0.0.1:${upstream.port}/*` },
            header: 'Authorization',
          },
        ],
      });
      const scriptPath = writeProxiedGetScript(tmpDir, upstream.port, '/orders', {});

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, scriptPath],
        { cwd: REPO_ROOT, reject: false, timeout: 15_000 },
      );

      expect(result.stdout).toContain('✖ orders API requires auth');
      expect(result.stdout).toContain('missing "Authorization" request header');
      expect(result.exitCode).toBe(1);
    } finally {
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits with the command-under-test's own exit code when it fails, even if every assertion passed", async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, { assertions: [] });

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, '-e', 'process.exit(7)'],
        { cwd: REPO_ROOT, reject: false, timeout: 15_000 },
      );

      expect(result.exitCode).toBe(7);
    } finally {
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails fast on a missing assertions file, without running the command under test', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', path.join(tmpDir, 'nope.json'), '--', process.execPath, '-e', '1'],
        { cwd: REPO_ROOT, reject: false, timeout: 15_000 },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Test assertions file not found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges an inherited NODE_EXTRA_CA_CERTS with detour's own CA instead of overwriting it (issue #148 review)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, { assertions: [] });

      const existingBundlePath = path.join(tmpDir, 'existing-ca-bundle.pem');
      const existingBundleContents = '-----BEGIN CERTIFICATE-----\nMARKER-EXISTING-BUNDLE\n-----END CERTIFICATE-----\n';
      fs.writeFileSync(existingBundlePath, existingBundleContents);

      const scriptPath = path.join(tmpDir, 'check-ca-bundle.js');
      fs.writeFileSync(
        scriptPath,
        `
        const fs = require('fs');
        const content = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8');
        if (!content.includes('MARKER-EXISTING-BUNDLE')) process.exit(2);
        if (!content.includes('BEGIN CERTIFICATE')) process.exit(3);
        process.exit(0);
        `,
      );

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, scriptPath],
        {
          cwd: REPO_ROOT,
          reject: false,
          timeout: 15_000,
          env: { ...process.env, NODE_EXTRA_CA_CERTS: existingBundlePath },
        },
      );

      expect(result.exitCode).toBe(0);
      // The pre-existing bundle itself must be untouched — only the child's
      // own NODE_EXTRA_CA_CERTS points at a separate, merged file.
      expect(fs.readFileSync(existingBundlePath, 'utf8')).toBe(existingBundleContents);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails with a clear error (not a raw fs stack trace) when an inherited NODE_EXTRA_CA_CERTS points to an unreadable file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, { assertions: [] });
      const missingBundlePath = path.join(tmpDir, 'does-not-exist.pem');

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, '-e', '1'],
        {
          cwd: REPO_ROOT,
          reject: false,
          timeout: 15_000,
          env: { ...process.env, NODE_EXTRA_CA_CERTS: missingBundlePath },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not read the existing NODE_EXTRA_CA_CERTS bundle');
      expect(result.stderr).toContain(missingBundlePath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('strips an inherited NO_PROXY/no_proxy from the command under test (issue #148 review — it could otherwise bypass the proxy entirely for localhost)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-e2e-'));
    try {
      const assertionsPath = writeAssertionsFile(tmpDir, { assertions: [] });
      const scriptPath = path.join(tmpDir, 'check-no-proxy.js');
      fs.writeFileSync(
        scriptPath,
        `
        if (process.env.NO_PROXY !== undefined || process.env.no_proxy !== undefined) process.exit(2);
        process.exit(0);
        `,
      );

      const result = await runTsx(
        ['src/cli.ts', 'test', '--assertions', assertionsPath, '--', process.execPath, scriptPath],
        {
          cwd: REPO_ROOT,
          reject: false,
          timeout: 15_000,
          env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' },
        },
      );

      expect(result.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('detour record / detour serve (issue #149, CLI end-to-end)', () => {
  /** Writes a small standalone Node script issuing one proxied GET for `upstreamPath` — same shape as `detour test`'s own `writeProxiedGetScript`, reproduced here since these describe blocks don't share helpers. */
  function writeProxiedGetScript(tmpDir: string, upstreamPort: number, upstreamPath: string): string {
    const scriptPath = path.join(tmpDir, 'client.js');
    fs.writeFileSync(
      scriptPath,
      `
      const http = require('http');
      const proxyUrl = new URL(process.env.HTTP_PROXY);
      const req = http.request(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          path: 'http://127.0.0.1:${upstreamPort}${upstreamPath}',
          method: 'GET',
        },
        (res) => {
          res.resume();
          res.on('end', () => process.exit(0));
        },
      );
      req.on('error', (err) => { console.error(err); process.exit(1); });
      req.end();
      `,
    );
    return scriptPath;
  }

  /** Issues one plain (non-proxied) GET directly against `detour serve`'s own port, resolving with status/headers/body. */
  function directGet(port: number, requestPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      // '127.0.0.1', matching `detour serve`'s own explicit bind address —
      // see its `server.listen(...)` call's doc comment for why that's the
      // literal IP rather than the hostname 'localhost' (which some
      // environments, including this repo's own CI runner, resolve to the
      // IPv6 loopback instead).
      const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Starts `detour serve <dir>` and waits for its DETOUR_SERVE_READY line, returning its port and a `kill()` to stop it — mirrors `startDetourCli`'s own ready-banner-polling shape for `detour start`. */
  async function startDetourServe(dir: string, port = 0): Promise<{ port: number; kill: () => Promise<void> }> {
    const subprocess = runTsx([path.join(REPO_ROOT, 'src/cli.ts'), 'serve', dir, '--port', String(port)], {
      cwd: REPO_ROOT,
      reject: false,
    });
    let stdout = '';
    subprocess.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const start = Date.now();
    while (!/DETOUR_SERVE_READY/.test(stdout)) {
      if (Date.now() - start > 10_000) {
        subprocess.kill();
        throw new Error(`detour serve never printed its ready line.\nstdout: ${stdout}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const portMatch = stdout.match(/DETOUR_SERVE_READY port=(\d+)/);
    if (!portMatch) throw new Error(`could not parse serve port from stdout: ${stdout}`);
    return {
      port: Number(portMatch[1]),
      kill: async () => {
        subprocess.kill('SIGTERM');
        await subprocess.catch(() => {});
      },
    };
  }

  it('records a real proxied exchange as a fixture file under --out', async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-record-e2e-'));
    const outDir = path.join(tmpDir, 'fixtures');
    try {
      const scriptPath = writeProxiedGetScript(tmpDir, upstream.port, '/orders/1');

      const result = await runTsx(['src/cli.ts', 'record', '--out', outDir, '--', process.execPath, scriptPath], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      });

      expect(result.exitCode).toBe(0);
      const files = fs.readdirSync(outDir).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      const fixture = JSON.parse(fs.readFileSync(path.join(outDir, files[0]!), 'utf8'));
      expect(fixture.method).toBe('GET');
      expect(fixture.path).toBe('/orders/1');
      expect(fixture.status).toBe(200);
      expect(JSON.parse(fixture.responseBody)).toMatchObject({ method: 'GET', path: '/orders/1' });
    } finally {
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('survives a fixture write failure instead of crashing the recording run (issue #149 review)', async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-record-e2e-'));
    try {
      // A plain file where --out needs a directory: writeFixtureFile's
      // mkdirSync(..., { recursive: true }) fails (ENOTDIR) trying to
      // create a subdirectory under a path component that's actually a
      // file, exercising the write-failure path without needing to
      // actually fill the disk.
      const blockerPath = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blockerPath, 'not a directory');
      const outDir = path.join(blockerPath, 'fixtures');

      const scriptPath = writeProxiedGetScript(tmpDir, upstream.port, '/orders/1');
      const result = await runTsx(['src/cli.ts', 'record', '--out', outDir, '--', process.execPath, scriptPath], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      });

      // The command under test still ran and exited cleanly — only
      // persisting the fixture failed, which is reported (via the same
      // proxy-error logging `detour test` uses) rather than crashing the
      // whole run.
      expect(result.exitCode).toBe(0);
      expect(String(result.stdout) + String(result.stderr)).toContain('proxy error');
    } finally {
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detour serve replays a hand-written fixture with no proxy involved at all', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-serve-e2e-'));
    let serve: { port: number; kill: () => Promise<void> } | undefined;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '00001-get-orders-1.json'),
        JSON.stringify({
          method: 'GET',
          path: '/orders/1',
          status: 200,
          responseHeaders: { 'content-type': 'application/json' },
          responseBody: '{"id":1,"name":"widget"}',
        }),
      );

      serve = await startDetourServe(tmpDir);
      const result = await directGet(serve.port, '/orders/1');

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ id: 1, name: 'widget' });
    } finally {
      await serve?.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detour serve responds 404 with a clear body for a request with no matching fixture', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-serve-e2e-'));
    let serve: { port: number; kill: () => Promise<void> } | undefined;
    try {
      serve = await startDetourServe(tmpDir);
      const result = await directGet(serve.port, '/unrecorded');

      expect(result.status).toBe(404);
      expect(JSON.parse(result.body).error).toContain('/unrecorded');
    } finally {
      await serve?.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detour serve strips a stale/hop-by-hop header from a hand-edited fixture instead of trusting it verbatim (issue #149 review)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-serve-e2e-'));
    let serve: { port: number; kill: () => Promise<void> } | undefined;
    try {
      const realBody = '{"id":1,"name":"widget"}';
      fs.writeFileSync(
        path.join(tmpDir, '00001-get-orders-1.json'),
        JSON.stringify({
          method: 'GET',
          path: '/orders/1',
          status: 200,
          // A hand-edited fixture with a deliberately wrong content-length
          // (and a hop-by-hop connection header) — a naive `writeHead` with
          // these passed straight through could send a mismatched
          // Content-Length or otherwise malformed response.
          responseHeaders: { 'content-type': 'application/json', 'content-length': '999999', connection: 'keep-alive' },
          responseBody: realBody,
        }),
      );

      serve = await startDetourServe(tmpDir);
      const result = await directGet(serve.port, '/orders/1');

      expect(result.status).toBe(200);
      expect(result.body).toBe(realBody);
    } finally {
      await serve?.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detour serve handles a "__proto__" fixture header key as an ordinary header name instead of a prototype write (issue #149 review)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-serve-e2e-'));
    let serve: { port: number; kill: () => Promise<void> } | undefined;
    try {
      // Written as raw JSON text, not built from a JS object literal — a
      // `{ __proto__: ... }` literal (or `obj['__proto__'] = ...` on a
      // normal object) sets the *actual* prototype instead of creating an
      // own property, so it wouldn't reproduce what `JSON.parse` produces
      // when loading this fixture back (a genuine own "__proto__" key).
      const fixtureJson =
        '{"method":"GET","path":"/x","status":200,"responseHeaders":{"content-type":"application/json","__proto__":["polluted"]},"responseBody":"{\\"ok\\":true}"}';
      fs.writeFileSync(path.join(tmpDir, '00001-get-x.json'), fixtureJson);

      serve = await startDetourServe(tmpDir);
      const result = await directGet(serve.port, '/x');

      expect(result.status).toBe(200);
      expect(result.body).toBe('{"ok":true}');
    } finally {
      await serve?.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('round-trips: records real traffic with `detour record`, then replays it with `detour serve` — no proxy on the replay side', async () => {
    const upstream = await startEchoServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-record-serve-e2e-'));
    const outDir = path.join(tmpDir, 'fixtures');
    let serve: { port: number; kill: () => Promise<void> } | undefined;
    try {
      const scriptPath = writeProxiedGetScript(tmpDir, upstream.port, '/orders/42');
      const recordResult = await runTsx(['src/cli.ts', 'record', '--out', outDir, '--', process.execPath, scriptPath], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      });
      expect(recordResult.exitCode).toBe(0);

      serve = await startDetourServe(outDir);
      const replayed = await directGet(serve.port, '/orders/42');

      expect(replayed.status).toBe(200);
      expect(JSON.parse(replayed.body)).toMatchObject({ method: 'GET', path: '/orders/42' });
    } finally {
      await serve?.kill();
      await upstream.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
