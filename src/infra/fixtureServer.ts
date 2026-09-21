import http from 'node:http';
import { DROPPED_RESPONSE_HEADERS } from '../domain/record/buildFixture';
import type { FixtureStore } from '../domain/record/fixtureStore';

export interface FixtureServerHandle {
  /** The port actually bound — resolves an ephemeral `0` to the real one. */
  port: number;
  stop: () => Promise<void>;
}

/**
 * The plain HTTP server behind `detour serve <dir>` (issue #149) — no proxy,
 * no TLS interception, no `HTTP_PROXY` for the client to set: a test's own
 * HTTP client points its base URL straight at it, and `store` decides which
 * recorded response each request replays.
 *
 * `onError` receives server errors that arrive *after* a successful bind; a
 * bind failure rejects the returned promise instead. Reported through a
 * callback rather than logged here because `infra/` may not import
 * `presentation/` (see `boundaries/dependencies` in eslint.config.mjs).
 */
export function startFixtureServer(options: {
  store: FixtureStore;
  port: number;
  onError: (error: Error) => void;
}): Promise<FixtureServerHandle> {
  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const requestPath = req.url ?? '/';
    const fixture = options.store.findFixture(method, requestPath);
    // Drains and discards any request body regardless of outcome below —
    // matching is method+path only (see `FixtureStore`'s doc comment), so
    // the body is never read, but leaving it unconsumed on a POST/PUT can
    // make the client see a connection reset instead of this response.
    req.resume();
    if (!fixture) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `No fixture recorded for ${method} ${requestPath}` }));
      return;
    }
    let body: Buffer | undefined;
    if (fixture.responseBody !== undefined) {
      const encoding = fixture.responseBodyEncoding === 'base64' ? 'base64' : 'utf8';
      body = Buffer.from(fixture.responseBody, encoding);
    }
    // Stripped again here, not just trusted from recording time: a
    // hand-edited fixture (or one written by something other than `detour
    // record`) could reintroduce a hop-by-hop header or a stale
    // content-length that would otherwise break the client or produce an
    // invalid response.
    // A null-prototype object, not `{}` — `fixture.responseHeaders` keys
    // come straight from a JSON file that could be hand-edited (or crafted),
    // and a `{}`'s inherited prototype means a key like `__proto__` would
    // pollute it instead of just being an inert, ordinary header name.
    const responseHeaders: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    for (const [key, value] of Object.entries(fixture.responseHeaders)) {
      if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
    }
    // Node's `writeHead` overload picks its meaning from the 2nd argument's
    // type — passing `undefined` there for a fixture with no statusMessage
    // would be read as "this is the headers argument", not "message
    // omitted", silently dropping the real headers object in the 3rd
    // position instead of using it.
    if (fixture.statusMessage) {
      res.writeHead(fixture.status, fixture.statusMessage, responseHeaders);
    } else {
      res.writeHead(fixture.status, responseHeaders);
    }
    res.end(body);
  });

  return new Promise<FixtureServerHandle>((resolve, reject) => {
    const onStartupError = (err: Error): void => reject(err);
    server.once('error', onStartupError);
    // The literal `'127.0.0.1'`, not the all-interfaces default a bare
    // `listen(port)` binds to (matching the rest of this codebase's
    // secure-by-default posture — the proxy/dashboard only bind everywhere
    // under an explicit `--lan`), and not the hostname `'localhost'`
    // either: this repo's own CI runner resolves `'localhost'` to the IPv6
    // loopback (`::1`), which broke a `127.0.0.1`-based client (the CLI's
    // own e2e tests included) — the numeric address sidesteps that
    // resolution entirely, and a test's own HTTP client base URL commonly
    // hardcodes `127.0.0.1` for exactly this kind of ambiguity.
    server.listen(options.port, '127.0.0.1', () => {
      // Otherwise this startup-only listener stays attached forever and a
      // later runtime error (e.g. an unexpected socket failure) would call
      // `reject` on an already-settled promise — a silent no-op — instead
      // of being visible anywhere.
      server.removeListener('error', onStartupError);
      server.on('error', options.onError);
      const address = server.address();
      resolve({
        port: address && typeof address === 'object' ? address.port : options.port,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
