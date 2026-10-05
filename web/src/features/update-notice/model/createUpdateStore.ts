import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
}

export type UpdatePhase = 'idle' | 'updating' | 'failed';

/** Progress of a user-requested "Check for updates": `checked`/`timeout` stay put until the next click so the result remains readable. */
export type CheckState = 'idle' | 'checking' | 'checked' | 'timeout';

export interface UpdateStoreState {
  /** Mirrors the server's `updateInfo` — `null` until one arrives (never, for installs that can't check). */
  info: UpdateInfo | null;
  phase: UpdatePhase;
  /** Why `phase` is `failed`. */
  message: string | undefined;
  /** The release the user chose to hide the banner for; a still-newer release brings it back. */
  dismissedVersion: string | null;
  checkState: CheckState;
  startUpdate: () => void;
  dismiss: () => void;
  /** Asks the server to look for a new release now instead of waiting out its cache; the answer arrives as `updateInfo`. */
  checkForUpdate: () => void;
}

/** The server's brew update + upgrade + relaunch usually takes well under this; past it, assume something went wrong. */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

/** The server answers a check as soon as GitHub does (its own request timeout is 10 s); past this, nothing is coming. */
export const CHECK_TIMEOUT_MS = 15 * 1000;

export interface UpdateStoreOptions {
  reload?: () => void;
  timeoutMs?: number;
  checkTimeoutMs?: number;
}

/**
 * The "new version available" banner's state (and the Update button's).
 * Once an update is running the server is stopped and relaunched on the new
 * version; the socket reconnects by itself and the fresh `updateInfo` then
 * reports a different `current` — the cue to reload, since the page's own
 * assets came from the old version.
 */
export function createUpdateStore(connection: DashboardConnection, options: UpdateStoreOptions = {}) {
  const reload = options.reload ?? (() => window.location.reload());
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS;
  const checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;

  return create<UpdateStoreState>((set, get) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    const clearCheckTimer = () => {
      if (checkTimer !== undefined) clearTimeout(checkTimer);
      checkTimer = undefined;
    };

    connection.onMessage((message) => {
      if (message.type === 'updateInfo') {
        const previous = get().info;
        if (get().checkState === 'checking') {
          clearCheckTimer();
          set({ checkState: 'checked' });
        }
        set({
          info: {
            current: message.current,
            latest: message.latest,
            updateAvailable: message.updateAvailable,
            canUpdate: message.canUpdate,
          },
        });
        if (get().phase === 'updating' && previous && previous.current !== message.current) {
          clearTimer();
          reload();
        }
      } else if (message.type === 'updateStatus' && message.state !== 'started' && get().phase === 'updating') {
        // Also broadcast when the updater exits without restarting the server;
        // only the tab that is waiting on it has anything to react to.
        clearTimer();
        set({ phase: 'failed', message: message.message ?? 'The update could not be started.' });
      }
    });

    return {
      info: null,
      phase: 'idle',
      message: undefined,
      dismissedVersion: null,
      checkState: 'idle',
      checkForUpdate: () => {
        if (get().checkState === 'checking') return;
        // A manual check is an explicit "tell me again": a release the user
        // earlier hid with "Later" should be allowed to resurface.
        set({ checkState: 'checking', dismissedVersion: null });
        connection.send({ type: 'checkUpdate' });
        clearCheckTimer();
        checkTimer = setTimeout(() => set({ checkState: 'timeout' }), checkTimeoutMs);
      },
      startUpdate: () => {
        if (get().phase === 'updating') return;
        set({ phase: 'updating', message: undefined });
        connection.send({ type: 'startUpdate' });
        clearTimer();
        timer = setTimeout(() => {
          set({
            phase: 'failed',
            message:
              'The update did not finish in time. See ~/.detour/update.log, or run `detour update` in a terminal.',
          });
        }, timeoutMs);
      },
      dismiss: () =>
        set({
          dismissedVersion: get().info?.latest ?? null,
          ...(get().phase === 'failed' ? { phase: 'idle' as const, message: undefined } : {}),
        }),
    };
  });
}
