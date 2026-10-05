import type { IncomingHttpHeaders } from 'node:http';
import type { WebSocket } from 'ws';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { isNewerVersion } from '../../domain/update/version';
import type { UpdateService } from '../../domain/update/updateService';

/** Debounces `startUpdate`: the updater takes a while to stop this process, and a double click must not launch two. */
const START_DEBOUNCE_MS = 3 * 60 * 1000;

const updateLogHint = '~/.detour/update.log';

export interface SocketTrust {
  /** The peer address is the loopback interface (the user at this machine's own browser). */
  isLoopback(socket: WebSocket): boolean;
  /** The socket proved a dashboard password via `login` — not merely grandfathered in before one was set. */
  isPasswordVerified(socket: WebSocket): boolean;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

/** A same-host reverse proxy makes every remote client look like loopback; the headers it adds give it away. */
export function hasForwardingHeaders(headers: IncomingHttpHeaders): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
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
 * action, so it's offered only to a client that is either at this machine
 * (loopback) or has proven the dashboard password — never to an anonymous
 * client on a `--lan` dashboard, which the rest of the dashboard's commands
 * are otherwise open to.
 */
export function createDashboardUpdates(
  service: UpdateService | undefined,
  trust: SocketTrust,
  now: () => number = Date.now,
  /** Called when the updater exits without having restarted this process, so every open tab can stop waiting. */
  onFailed: (message: string) => void = () => {},
): DashboardUpdates {
  const mayUpdate = (socket: WebSocket) =>
    !!service?.canSelfUpdate && (trust.isLoopback(socket) || trust.isPasswordVerified(socket));
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let updating = false;

  return {
    isUpdating: () => updating,
    async infoFor(socket) {
      if (!service) return null;
      const latest = await service.getLatestVersion();
      return {
        type: 'updateInfo',
        current: service.currentVersion,
        latest,
        updateAvailable: latest !== null && isNewerVersion(latest, service.currentVersion),
        canUpdate: mayUpdate(socket),
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
