import type { WebSocket } from 'ws';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { isNewerVersion } from '../../domain/update/version';
import type { UpdateService } from '../../domain/update/updateService';

/** Debounces `startUpdate`: the updater takes a while to stop this process, and a double click must not launch two. */
const START_DEBOUNCE_MS = 3 * 60 * 1000;

const updateLogHint = '~/.detour/update.log';

export interface SocketTrust {
  /**
   * The socket proved a secret — the dashboard password via `login`, or the
   * access token (issue #205) — rather than merely being grandfathered in
   * while neither was required. Where the connection came from plays no
   * part: the proxy relays LAN clients' requests from the loopback
   * interface, so "the peer is loopback" says nothing about who is at the
   * keyboard.
   */
  isVerified(socket: WebSocket): boolean;
}

export interface DashboardUpdates {
  /** The `updateInfo` message for one socket, or null when update checking isn't configured. */
  infoFor(socket: WebSocket): Promise<DashboardServerMessage | null>;
  /** Handles `checkUpdate`: re-runs the release lookup past the cache; the caller then re-sends `updateInfo` to every client. */
  refresh(): Promise<void>;
  /** Handles `startUpdate` from one socket and returns the `updateStatus` to send back to it. */
  start(socket: WebSocket): Promise<DashboardServerMessage>;
  /** Whether an update was launched from the dashboard and hasn't ended without restarting this process — i.e. this process is about to be stopped for it. */
  isUpdating(): boolean;
}

/**
 * Running `brew upgrade` and restarting the process is arbitrary host-level
 * action, so it's offered only to a client that has proven a secret (the
 * dashboard password or the access token, issue #205) — never to one that was
 * merely let in, and never on the strength of coming from loopback.
 */
export function createDashboardUpdates(
  service: UpdateService | undefined,
  trust: SocketTrust,
  now: () => number = Date.now,
  /** Called when the updater exits without having restarted this process, so every open tab can stop waiting. */
  onFailed: (message: string) => void = () => {},
): DashboardUpdates {
  const mayUpdate = (socket: WebSocket) => !!service?.canSelfUpdate && trust.isVerified(socket);
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let updating = false;

  return {
    isUpdating: () => updating,
    async infoFor(socket) {
      if (!service) return null;
      const latest = await service.getLatestVersion();
      const failure = latest === null ? service.lastFailure() : null;
      return {
        type: 'updateInfo',
        current: service.currentVersion,
        latest,
        updateAvailable: latest !== null && isNewerVersion(latest, service.currentVersion),
        canUpdate: mayUpdate(socket),
        ...(failure ? { failure } : {}),
      };
    },
    async refresh() {
      await service?.getLatestVersion({ force: true });
    },
    async start(socket) {
      if (!service?.canSelfUpdate) {
        return {
          type: 'updateStatus',
          state: 'rejected',
          message: 'This install cannot update itself. Run `detour update` in a terminal.',
        };
      }
      if (!mayUpdate(socket)) {
        return {
          type: 'updateStatus',
          state: 'rejected',
          message: 'Updating from the dashboard is only allowed from this machine or a password-authenticated session.',
        };
      }
      if (now() - lastStartedAt < START_DEBOUNCE_MS) {
        return { type: 'updateStatus', state: 'rejected', message: 'An update is already in progress.' };
      }
      // Armed before the await: two sockets racing through the spawn must not both launch an updater.
      lastStartedAt = now();
      updating = true;
      try {
        await service.startUpdate((exitCode) => {
          lastStartedAt = Number.NEGATIVE_INFINITY;
          updating = false;
          onFailed(
            `The updater exited (code ${exitCode ?? 'unknown'}) without restarting Detour. See ${updateLogHint}.`,
          );
        });
        return { type: 'updateStatus', state: 'started' };
      } catch (err) {
        lastStartedAt = Number.NEGATIVE_INFINITY;
        updating = false;
        return { type: 'updateStatus', state: 'failed', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
