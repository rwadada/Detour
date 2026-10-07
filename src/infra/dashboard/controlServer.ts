import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tokensEqual } from '../../domain/auth/dashboardAccess';
import { validateBlockHosts, validateThrottle } from '../../domain/dashboard/clientMessage';
import type { BlockHostsState, CapturedExchange, ThrottleState, WireExchange } from '../../domain/exchange/types';
import { toWireExchange } from '../../domain/exchange/wireExchange';
import type { RuleProfileSummary } from '../../domain/rules/profile';
import type { Rule, RulesFile } from '../../domain/rules/types';
import { validateRulesData } from '../../domain/rules/schema';
import { findRejectedScriptWrites } from '../../domain/rules/scriptGate';
import type { ReloadInfo } from '../../usecase/ruleEngine';

/**
 * The control API (issue #212): a small REST interface so a test runner can
 * drive a *running* Detour — swap rules, switch profiles, reset between cases,
 * read back what went through — which until now meant poking the dashboard's
 * WebSocket (built for a human at a browser) or rewriting `rules.json` and
 * hoping the file watcher had caught up.
 *
 * Deliberately narrow:
 * - **Off by default** (`--control-port`), bound to `127.0.0.1` only.
 * - **A bearer token on every request** — the dashboard's access token
 *   (issue #205), so there is one secret to protect, not two.
 * - **Not a browser API.** A request carrying an `Origin` header is refused
 *   (so a web page cannot drive it, DNS rebinding or not), no CORS headers are
 *   ever sent, and the `Host` header must name a loopback address.
 * - **Writes answer only once they have taken effect**, so `PUT /rules`
 *   followed straight away by traffic is not a race.
 *
 * It calls into the same pieces the dashboard's WebSocket handlers use
 * (`ControlDeps`), rather than reimplementing them.
 */

/** What the control API needs from the running dashboard/proxy — supplied by `dashboardServer.ts`. */
export interface ControlDeps {
  /** The active rules file's engine, or `undefined` when the session has none (no `--rules`, nothing applied yet). */
  getRuleEngine(): RuleEngineLike | undefined;
  /** Provisions an engine when none exists yet (what `applyRuleProfile` does from the dashboard); may throw. */
  ensureRuleEngine(): RuleEngineLike | undefined;
  /** Saved rule profiles, or `undefined` when they are unavailable. */
  profiles(): ProfilesLike | undefined;
  /** The captured exchanges, oldest first. */
  exchanges(): CapturedExchange[];
  /** Forgets every captured exchange. */
  clearExchanges(): void;
  /** Applies a throttle profile and resolves with what the proxy then reports it is using. */
  setThrottle(state: ThrottleState): Promise<ThrottleState>;
  /** Applies a Block Hosts list and resolves with what the proxy then reports it is using. */
  setBlockHosts(state: BlockHostsState): Promise<BlockHostsState>;
  /** The running Detour's version, for `GET /health`. */
  version: string | undefined;
}

export interface RuleEngineLike {
  getRules(): readonly Rule[];
  getActiveProfile(): string | undefined;
  writeAndReload(rules: Rule[], opts?: { activeProfile?: string }): ReloadInfo;
  resetMockSequences(): void;
}

/** The saved-profiles store — `RuleProfileStore` (see usecase/ports/ruleProfileStore.ts), narrowed to what the control API reads. */
export interface ProfilesLike {
  list(): RuleProfileSummary[];
  /** Throws if no profile named `name` exists, or it fails validation. */
  read(name: string): RulesFile;
}

export interface ControlServerOptions {
  port: number;
  /** The dashboard access token every request must present as `Authorization: Bearer <token>`. */
  token: string;
}

export interface ControlServerHandle {
  /** The port actually bound (relevant when `port` was 0). */
  port: number;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return reject(new HttpError(400, 'A JSON request body is required'));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Whether `Host` names a loopback address — a request for any other name is a DNS-rebinding attempt or a misdirected client. */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.split(':')[0]!;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** `/rules/` → `/rules`; the root stays `/`. */
function trimTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === '/') end--;
  return pathname.slice(0, end);
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const space = header.indexOf(' ');
  if (space === -1 || header.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const token = header.slice(space + 1).trim();
  return token === '' ? undefined : token;
}

/**
 * The rules must have a valid shape *before* anything inspects them: the
 * script gate reads `rule.action.type`, which a malformed rule does not have.
 * (The dashboard gets this for free from `parseClientMessage`.) Throws a 400
 * listing every problem, not just the first.
 */
function assertValidRules(rules: unknown): asserts rules is Rule[] {
  const result = validateRulesData({ rules });
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e}`).join('\n');
    throw new HttpError(400, `Rules failed validation:\n${details}`);
  }
}

/** `?since=` as epoch milliseconds; `undefined` when absent, an `HttpError` when not a number. */
function parseSince(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, '`since` must be a number of milliseconds since the epoch');
  return n;
}

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '`limit` must be a positive integer');
  return n;
}

function filterExchanges(all: CapturedExchange[], query: URLSearchParams): WireExchange[] {
  const since = parseSince(query.get('since'));
  const limit = parseLimit(query.get('limit'));
  const urlContains = query.get('url')?.toLowerCase();
  const method = query.get('method')?.toUpperCase();
  const status = query.get('status');
  let matched = all.filter(
    (e) =>
      (since === undefined || e.startedAt >= since) &&
      (urlContains === undefined || e.url.toLowerCase().includes(urlContains)) &&
      (method === undefined || e.method.toUpperCase() === method) &&
      (status === null || String(e.statusCode) === status),
  );
  // The most recent `limit`, still oldest-first — what an assertion reads.
  if (limit !== undefined) matched = matched.slice(-limit);
  return matched.map(toWireExchange);
}

function activeRulesBody(engine: RuleEngineLike | undefined): { rules: readonly Rule[]; activeProfile: string | null } {
  return { rules: engine?.getRules() ?? [], activeProfile: engine?.getActiveProfile() ?? null };
}

export async function startControlServer(
  options: ControlServerOptions,
  deps: ControlDeps,
): Promise<ControlServerHandle> {
  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = trimTrailingSlashes(url.pathname);

    if (method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, version: deps.version ?? null });

    if (method === 'GET' && path === '/rules') return sendJson(res, 200, activeRulesBody(deps.getRuleEngine()));

    if (method === 'PUT' && path === '/rules') {
      const body = (await readJsonBody(req)) as { rules?: unknown } | null;
      if (!body || !Array.isArray(body.rules)) throw new HttpError(400, 'Body must be {"rules": [...]}');
      const engine = deps.getRuleEngine();
      if (!engine) throw new HttpError(409, 'No rules file is configured for this session — start with --rules');
      const rules: unknown = body.rules;
      assertValidRules(rules);
      // Issue #161's gate, same as the dashboard's `setRules`: a write may not add a `script` rule or change one's path.
      const violations = findRejectedScriptWrites(engine.getRules(), rules);
      if (violations.length > 0) throw new HttpError(403, violations.join('; '));
      return sendJson(res, 200, {
        ...(await applyRules(() => engine.writeAndReload(rules))),
        ...activeRulesBody(engine),
      });
    }

    if (method === 'GET' && path === '/profiles') {
      return sendJson(res, 200, { profiles: deps.profiles()?.list() ?? [] });
    }

    const activate = path.match(/^\/profiles\/([^/]+)\/activate$/);
    if (method === 'POST' && activate) {
      const name = decodeURIComponent(activate[1]!);
      const profiles = deps.profiles();
      if (!profiles) throw new HttpError(409, 'Rule profiles are unavailable');
      if (!profiles.list().some((p) => p.name === name)) throw new HttpError(404, `No rule profile named "${name}"`);
      const engine = deps.ensureRuleEngine();
      if (!engine) throw new HttpError(409, 'Rule profiles are unavailable');
      const rules = profiles.read(name).rules;
      const violations = findRejectedScriptWrites(engine.getRules(), rules);
      if (violations.length > 0) throw new HttpError(403, violations.join('; '));
      return sendJson(res, 200, {
        ...(await applyRules(() => engine.writeAndReload(rules, { activeProfile: name }))),
        ...activeRulesBody(engine),
      });
    }

    if (method === 'POST' && path === '/reset') {
      deps.getRuleEngine()?.resetMockSequences();
      deps.clearExchanges();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/exchanges') {
      return sendJson(res, 200, { exchanges: filterExchanges(deps.exchanges(), url.searchParams) });
    }

    if (method === 'PUT' && path === '/throttle') {
      const body = await readJsonBody(req);
      const problem = validateThrottle(body);
      if (problem) throw new HttpError(400, problem);
      return sendJson(res, 200, await deps.setThrottle(body as ThrottleState));
    }

    if (method === 'PUT' && path === '/block-hosts') {
      const body = await readJsonBody(req);
      const problem = validateBlockHosts(body);
      if (problem) throw new HttpError(400, problem);
      return sendJson(res, 200, await deps.setBlockHosts(body as BlockHostsState));
    }

    throw new HttpError(404, `No such endpoint: ${method} ${path}`);
  }

  /** Turns a failed write (invalid rules, an unreadable file) into a 400 carrying its message; the previous rules keep serving. */
  async function applyRules(apply: () => ReloadInfo): Promise<ReloadInfo> {
    try {
      return apply();
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  const server = http.createServer((req, res) => {
    // Not a browser API: a browser always sends `Origin` on a cross-origin
    // request (and on every WebSocket/`fetch` POST), a script never does.
    if (req.headers.origin !== undefined) return sendJson(res, 403, { error: 'Browser requests are not accepted' });
    if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'Host must be a loopback address' });
    const presented = bearerToken(req);
    if (presented === undefined || !tokensEqual(presented, options.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Detour control API"');
      return sendJson(res, 401, { error: 'A valid bearer token is required (the dashboard access token)' });
    }
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
