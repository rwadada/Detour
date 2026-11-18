import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { requestHasValidToken } from '../../domain/auth/dashboardAccess';
import { verifyPassword } from '../../domain/auth/passwordHash';
import type { DashboardClientMessage, DashboardServerMessage } from '../../domain/dashboard/protocol';
import { canonicalIp, isLoopbackAddress } from '../proxy/engine/selfTarget';
import { createLoginBudget } from './loginBudget';

// Login rate limiting (issue #159). Tracked by *IP*, not per-socket — closing a socket and opening a fresh one is
// free, so a per-socket counter would reset on every reconnect and defend nothing. In-memory only: resetting on a
// `detour start` restart is fine, nothing here needs to survive one.
const MAX_LOGIN_FAILURES = 5;
const MAX_UNAUTHENTICATED_SOCKETS_PER_IP = 3;
const LOGIN_BACKOFF_BASE_MS = 20;
const LOGIN_BACKOFF_MAX_MS = 320;
/**
 * Bounds how many distinct IPs `loginFailuresByIp` tracks at once (Copilot review, PR #175) — unlike
 * `unauthenticatedSocketCountByIp` (an entry is always removed on auth/close, so it can never outgrow the number of
 * sockets actually open right now), a failure record has no such natural ceiling: it lives until that IP eventually
 * logs in successfully, which an attacker has no reason to ever do. `recordLoginFailure` evicts the oldest-inserted
 * entry once at this cap, rather than refusing new ones — a memory ceiling matters more here than perfect fairness
 * toward whichever IP happens to hit it first.
 */
const MAX_TRACKED_LOGIN_FAILURE_IPS = 1000;
/** The first lockout's length; each later one for the same key doubles it, up to a day (see `loginBudget.ts`). */
const LOGIN_LOCKOUT_MS = 15 * 60_000;
const LOGIN_LOCKOUT_MAX_MS = 24 * 60 * 60_000;
/** The escalation cap for a key many clients share (loopback, the remote-wide tally) — see where each is created. */
const SHARED_LOCKOUT_MAX_MS = 60 * 60_000;
/**
 * Failures every non-loopback client together may add up before password
 * login is locked out for all of them. A per-address limit alone can be
 * walked past by a client able to change addresses (an IPv6 range hands out
 * as many as it likes); this one counts across addresses, so it can't.
 * Loopback is left out of it, so the owner at the machine itself is never
 * locked out by what the network does.
 */
const MAX_REMOTE_LOGIN_FAILURES = 25;
/** The key of that shared, all-remote-clients tally. */
const REMOTE = 'remote';

const AUTH_FAILED: DashboardServerMessage = { type: 'authFailed' };

export interface DashboardAuthDeps {
  /** The access token (issue #205) that protects the dashboard when no password is set; `undefined` = open. */
  accessToken: string | undefined;
  /** Reads the stored password hash (`null` = none). Throws when the config cannot be read. */
  loadPasswordHash: () => string | null;
  /** Sends the just-connected snapshot to a socket that has just authenticated. */
  sendInitialPayload: (socket: WebSocket) => void;
  /** The wait before a failed login is answered (issue #159's backoff). Injectable so tests need not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock a lockout expires by. Injectable so tests need not really wait. */
  now?: () => number;
}

/** What `admitConnection` decided for a new socket. */
type Admission = 'authenticated' | 'needs-login' | 'rejected';

export interface DashboardAuth {
  isAuthenticated: (socket: WebSocket) => boolean;
  /**
   * Whether `socket` really proved a secret — a password via `login`, or the access token (issue #205) — as
   * opposed to being grandfathered in while neither was required. This is what decides who may trigger a
   * self-update; where a connection came *from* (loopback) deliberately plays no part, since the proxy relays LAN
   * clients' requests from loopback.
   */
  isVerified: (socket: WebSocket) => boolean;
  /** Read fresh on every call; on a read failure, the last value a successful read produced (fail closed). */
  currentPasswordHash: () => string | null;
  /** Records a password change right away and revokes every earlier password proof. */
  onPasswordChanged: (hash: string | null) => void;
  /** Decides what a freshly connected socket may do, closing it when it must not stay. */
  admitConnection: (socket: WebSocket, req: IncomingMessage) => Admission;
  /** The message that tells a not-yet-authenticated client how to authenticate. */
  authRequiredMessage: () => DashboardServerMessage;
  /** Answers a `login` attempt from a socket `admitConnection` let stay for it; any other socket is ignored. */
  handleLogin: (socket: WebSocket, message: Extract<DashboardClientMessage, { type: 'login' }>) => Promise<void>;
}

/**
 * The key a connection's rate-limit counters are tracked under — the raw
 * socket address in one spelling (an IPv4-mapped one counts as the IPv4
 * address it is), not anything a client-controlled header could spoof.
 */
export function rateLimitKey(remoteAddress: string | undefined): string {
  return remoteAddress ? canonicalIp(remoteAddress) : 'unknown';
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line max-lines-per-function -- cohesive per-IP rate-limit + session state closure extracted from dashboardServer (issue #207)
export function createDashboardAuth(deps: DashboardAuthDeps): DashboardAuth {
  const sleep = deps.sleep ?? realSleep;
  // Issue #66's optional dashboard password: sockets that have proven they know the current password (or connected
  // while none was configured) live in this set. A `WeakSet` rather than a plain property on the socket so nothing
  // here needs to remember to clean up on close — an unreachable socket just falls out of it.
  const authenticatedSockets = new WeakSet<WebSocket>();
  // `let` so that changing the password can revoke every earlier proof at once.
  let passwordVerifiedSockets = new WeakSet<WebSocket>();
  const tokenVerifiedSockets = new WeakSet<WebSocket>();
  // Sockets with a `login` currently awaiting `verifyPassword` — guards against two `login` frames racing each other:
  // both would pass the "not authenticated" check before either resolves, and depending on which `await` settles
  // second, that one could send `authFailed` after the socket was already authenticated by the first, or duplicate
  // the initial snapshot. A `login` that arrives while one's already in flight for that socket is dropped rather than
  // queued — a real client only ever has one outstanding attempt at a time.
  const loginInFlight = new WeakSet<WebSocket>();
  const now = deps.now ?? Date.now;
  const lockout = { baseLockoutMs: LOGIN_LOCKOUT_MS, maxLockoutMs: LOGIN_LOCKOUT_MAX_MS, now };
  const addressFailures = createLoginBudget({
    limit: MAX_LOGIN_FAILURES,
    maxTracked: MAX_TRACKED_LOGIN_FAILURE_IPS,
    ...lockout,
  });
  // Escalates only up to an hour: anyone on the network can feed this tally,
  // so a longer lockout would hand them a long denial of service against every
  // remote device; an hour still holds a guesser to a few hundred tries a day.
  const remoteFailures = createLoginBudget({
    limit: MAX_REMOTE_LOGIN_FAILURES,
    maxTracked: 1,
    ...lockout,
    maxLockoutMs: SHARED_LOCKOUT_MAX_MS,
  });
  // Loopback gets its own budget whose lockouts escalate only up to an hour.
  // Every local process shares that address (so does anything a local tunnel
  // or reverse proxy forwards), so a day-long lockout would mostly lock the
  // owner out; an hour still holds a guesser behind it to ~120 tries a day.
  const loopbackFailures = createLoginBudget({
    limit: MAX_LOGIN_FAILURES,
    maxTracked: MAX_TRACKED_LOGIN_FAILURE_IPS,
    ...lockout,
    maxLockoutMs: SHARED_LOCKOUT_MAX_MS,
  });
  const budgetFor = (ip: string) => (isLoopbackAddress(ip) ? loopbackFailures : addressFailures);
  /** Whether a client at `ip` is locked out right now — by its own failures, or (off loopback) by all remote ones. */
  const lockedOut = (ip: string): boolean =>
    budgetFor(ip).isLocked(ip) || (!isLoopbackAddress(ip) && remoteFailures.isLocked(REMOTE));
  const unauthenticatedSocketCountByIp = new Map<string, number>();
  // Which sockets currently hold a counted slot in `unauthenticatedSocketCountByIp` — released exactly once,
  // whichever of "authenticated" or "closed" happens first, so the count never double-decrements.
  const unauthenticatedSlotSockets = new WeakSet<WebSocket>();
  // The IP each admitted socket was counted under, fixed at admission: login must charge failures and release the
  // slot against that same key, whatever `req` looks like by then.
  const ipBySocket = new WeakMap<WebSocket, string>();
  // Bumped on every password change, so a `login` that began under the old password can tell it has been revoked.
  let passwordGeneration = 0;

  /** Releases `socket`'s counted slot (idempotent — a no-op if it never held one, or already released it). */
  function releaseUnauthenticatedSlot(socket: WebSocket, ip: string): void {
    if (!unauthenticatedSlotSockets.has(socket)) return;
    unauthenticatedSlotSockets.delete(socket);
    const current = unauthenticatedSocketCountByIp.get(ip) ?? 0;
    if (current <= 1) unauthenticatedSocketCountByIp.delete(ip);
    else unauthenticatedSocketCountByIp.set(ip, current - 1);
  }

  /** Records one more login failure for `ip` (and, off loopback, the remote tally); returns its count toward the current lockout. */
  function recordLoginFailure(ip: string): number {
    if (!isLoopbackAddress(ip)) remoteFailures.recordFailure(REMOTE);
    return budgetFor(ip).recordFailure(ip);
  }

  /** Takes back an attempt `recordLoginFailure` charged up front that turned out not to be a wrong guess. */
  function refundLoginFailure(ip: string): void {
    if (!isLoopbackAddress(ip)) remoteFailures.refund(REMOTE);
    budgetFor(ip).refund(ip);
  }

  // Read fresh on every check (connect, login attempt, `setDashboardPassword`) rather than cached once at startup —
  // it's what lets a password set via the Settings panel or `detour config` start applying to new connections
  // without a restart.
  //
  // On a read failure (invalid JSON, a validation failure), this returns the last value a *successful* read actually
  // produced, rather than `null`: `null` means "no password configured" everywhere it's checked, so falling back to
  // it unconditionally on error would fail *open* — waving every new connection straight through the moment
  // `~/.detour/config.json` gets corrupted while a password happens to be set. Falling back to the last-known value
  // instead keeps a real password honored across a transient corruption, while a config that never had one to begin
  // with still resolves to `null`.
  let lastKnownPasswordHash: string | null = null;
  const currentPasswordHash = (): string | null => {
    try {
      lastKnownPasswordHash = deps.loadPasswordHash();
    } catch {
      // Keep `lastKnownPasswordHash` as it was — see the comment above.
    }
    return lastKnownPasswordHash;
  };

  const isVerified = (socket: WebSocket) => passwordVerifiedSockets.has(socket) || tokenVerifiedSockets.has(socket);

  function admitConnection(socket: WebSocket, req: IncomingMessage): Admission {
    // No password configured: grandfather this socket in permanently, even if a password gets set later while it's
    // still open — same "changing the Wi-Fi password doesn't kick already-connected devices" posture as `--lan`'s
    // own bind-at-spawn-time semantics. Only *new* connections made after that point are asked for it.
    if (!currentPasswordHash()) {
      if (!deps.accessToken) {
        authenticatedSockets.add(socket);
      } else if (requestHasValidToken(deps.accessToken, { url: req.url, cookieHeader: req.headers.cookie })) {
        authenticatedSockets.add(socket);
        tokenVerifiedSockets.add(socket);
      }
    }
    if (authenticatedSockets.has(socket)) return 'authenticated';

    const ip = rateLimitKey(req.socket.remoteAddress);
    // An IP that's already exhausted its attempts doesn't get a fresh set just by reconnecting — closing a socket
    // and opening a new one is free, so a per-socket-only limit would defend nothing.
    if (lockedOut(ip)) {
      socket.close(1008, 'Too many failed login attempts');
      return 'rejected';
    }
    // Bounds how many *unauthenticated* sockets one IP can hold open at once (issue #159) — without this, one client
    // could open many parallel connections to run scrypt verifications concurrently (`login`'s KDF work runs on
    // libuv's shared threadpool, so enough parallel attempts starve every other `fs`-backed operation sharing that
    // pool) or to spread brute-force attempts across more sockets than the per-socket guard alone limits.
    const unauthenticatedCount = unauthenticatedSocketCountByIp.get(ip) ?? 0;
    if (unauthenticatedCount >= MAX_UNAUTHENTICATED_SOCKETS_PER_IP) {
      socket.close(1008, 'Too many concurrent unauthenticated connections');
      return 'rejected';
    }
    unauthenticatedSocketCountByIp.set(ip, unauthenticatedCount + 1);
    unauthenticatedSlotSockets.add(socket);
    ipBySocket.set(socket, ip);
    socket.once('close', () => releaseUnauthenticatedSlot(socket, ip));
    return 'needs-login';
  }

  async function handleLogin(
    socket: WebSocket,
    message: Extract<DashboardClientMessage, { type: 'login' }>,
  ): Promise<void> {
    // Failures and the slot are charged to the IP fixed at admission. A socket with none was never admitted to
    // log in (it cannot reach here through the server), and re-deriving an address could charge a different key.
    const ip = ipBySocket.get(socket);
    if (ip === undefined || loginInFlight.has(socket)) return;
    // A socket admitted before a lockout began doesn't keep guessing on it:
    // nothing is verified while the lockout lasts.
    // Closed with the lockout's own reason rather than `authFailed`, which
    // would read as a wrong password.
    if (lockedOut(ip)) {
      socket.close(1008, 'Too many failed login attempts');
      return;
    }
    loginInFlight.add(socket);
    // Charged up front and refunded if it turns out right: counting only after
    // the (slow) verify would let a burst of parallel attempts all pass the
    // lockout check above before any of them had been counted.
    const failures = recordLoginFailure(ip);
    try {
      const hash = currentPasswordHash();
      const generation = passwordGeneration;
      let verified: boolean;
      try {
        // No password configured: nothing to verify against, so `login` can only succeed where the dashboard is open
        // — never where the access token is what protects it (issue #205), or a `login` with any string would get
        // past it.
        verified = hash ? await verifyPassword(message.password, hash) : !deps.accessToken;
      } catch {
        // A crypto failure verifying the password is the server's problem, not proof the client is wrong — but it
        // still needs *some* response, or the socket is stranded locked out with no `authFailed` to prompt a retry.
        verified = false;
      }
      // The password was changed while this attempt was being verified: a proof against the old one is already
      // revoked, so it must not authenticate the socket (or earn the right to a host-level update). The client is
      // told to try again, but the attempt is not charged to the IP — it was answered against a credential that
      // no longer exists, so it says nothing about whether the client is guessing.
      if (generation !== passwordGeneration) {
        refundLoginFailure(ip);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(AUTH_FAILED));
        return;
      }
      if (verified) {
        budgetFor(ip).reset(ip);
        // The remote tally's failures too (not its lockout history): otherwise
        // the LAN's occasional typos, each followed by a successful login,
        // would add up to a lockout over time.
        if (!isLoopbackAddress(ip)) remoteFailures.forgiveFailures(REMOTE);
        releaseUnauthenticatedSlot(socket, ip);
        authenticatedSockets.add(socket);
        passwordVerifiedSockets.add(socket);
        deps.sendInitialPayload(socket);
        return;
      }
      // Exponential backoff (issue #159) before even answering: makes each successive wrong guess from this IP
      // slower than the last, on top of scrypt's own ~20ms+ per attempt.
      await sleep(Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (failures - 1), LOGIN_BACKOFF_MAX_MS));
      // The socket (or the whole server) could have gone away during that delay — nothing left to answer.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(AUTH_FAILED));
      // Issue #159's acceptance criterion: the 5th consecutive failure from an IP ends that socket outright, rather
      // than leaving it free to keep guessing — reconnecting doesn't help either, since `admitConnection` checks
      // this same counter before a new socket is ever handed an `authRequired` at all.
      if (failures >= MAX_LOGIN_FAILURES || lockedOut(ip)) {
        socket.close(1008, 'Too many failed login attempts');
      }
    } finally {
      loginInFlight.delete(socket);
    }
  }

  return {
    isAuthenticated: (socket) => authenticatedSockets.has(socket),
    isVerified,
    currentPasswordHash,
    onPasswordChanged: (hash) => {
      // Updates `lastKnownPasswordHash` immediately rather than waiting for some future `currentPasswordHash()` call
      // to catch up: without this, a password set here has no effect on the fail-closed fallback until the next
      // read happens to succeed — leaving a window, right after setting a password, where the config becoming
      // unreadable would still fail open.
      lastKnownPasswordHash = hash;
      passwordGeneration++;
      // A session that logged in with the old password must not keep the right to run a host-level update after
      // it's been changed.
      passwordVerifiedSockets = new WeakSet<WebSocket>();
    },
    admitConnection,
    // Uses the hash `admitConnection` just read, not a second read: the answer must agree with the admission
    // decision even if the config changes in between.
    authRequiredMessage: () => ({ type: 'authRequired', method: lastKnownPasswordHash ? 'password' : 'token' }),
    handleLogin,
  };
}
