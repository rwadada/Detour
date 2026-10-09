import type { WebSocket } from 'ws';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { AdbReverseWatcher } from '../adb/adbReverseWatcher';
import type { SocketTrust } from './dashboardUpdates';

export interface DashboardAdbReverse {
  /** The `adbReverseState` message for one socket (`canChange` depends on who is asking). */
  stateFor(socket: WebSocket): DashboardServerMessage;
  /**
   * Handles `setAdbReverse` from one socket. Returns false — and changes nothing — when
   * the socket has not proved the dashboard password or access token: turning this on
   * runs `adb` on this machine, which a client that was merely let in must not be able
   * to do (same rule as the one-click update, issue #205).
   */
  setEnabled(socket: WebSocket, enabled: boolean): boolean;
  /**
   * Starts the watcher when it was asked to be on from the start. Called once the server is
   * known to be up: starting it while the server was still being set up would leave an
   * `adb track-devices` behind whenever that setup then failed (a port in use, say).
   */
  begin(): void;
  /** Stops the watcher if it is running (process shutdown). */
  stop(): void;
}

export interface DashboardAdbReverseOptions {
  /** The proxy port the reverse forwards. */
  port: number;
  /** Starts a watcher; called each time it is turned on. */
  startWatcher: () => AdbReverseWatcher;
  /** On from the start (`--adb-reverse`): the first thing it does is start a watcher. */
  enabledAtStart?: boolean;
  trust: SocketTrust;
  /** Called after every change, so the server can send the new state to every client. */
  onChange: () => void;
}

/**
 * The dashboard's switch for `--adb-reverse`: owns whether a watcher is running, so the
 * flag and the switch are one thing rather than two that could disagree.
 */
export function createDashboardAdbReverse(options: DashboardAdbReverseOptions): DashboardAdbReverse {
  let watcher: AdbReverseWatcher | undefined;

  return {
    stateFor(socket) {
      return {
        type: 'adbReverseState',
        enabled: watcher !== undefined,
        usbDevices: watcher?.connectedUsbDevices() ?? 0,
        port: options.port,
        canChange: options.trust.isVerified(socket),
      };
    },
    setEnabled(socket, enabled) {
      if (!options.trust.isVerified(socket)) return false;
      if (enabled && !watcher) {
        watcher = options.startWatcher();
        options.onChange();
      } else if (!enabled && watcher) {
        watcher.stop();
        watcher = undefined;
        options.onChange();
      }
      return true;
    },
    begin() {
      if (options.enabledAtStart && !watcher) watcher = options.startWatcher();
    },
    stop() {
      watcher?.stop();
      watcher = undefined;
    },
  };
}
