import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface AdbReverseInfo {
  enabled: boolean;
  /** USB Android devices connected right now. */
  usbDevices: number;
  /** The proxy port being forwarded. */
  port: number;
  /** Whether this client proved the password or token, i.e. may flip the switch. */
  canChange: boolean;
}

export interface AdbReverseStoreState {
  /** Mirrors the server's `adbReverseState` — `null` until one arrives (never, when the switch isn't configured). */
  info: AdbReverseInfo | null;
  /** A change was sent and no answer has come back yet; the switch shows the server's state, not the one asked for. */
  pending: boolean;
  setEnabled: (enabled: boolean) => void;
}

/** The server answers a change at once (it is one local call); past this, nothing is coming and the switch should be usable again. */
export const PENDING_TIMEOUT_MS = 5 * 1000;

/**
 * State of the "keep adb reverse in place" switch. The server is the only source of truth:
 * a click sends `setAdbReverse` and leaves the switch where it was until `adbReverseState`
 * says what actually happened — an optimistic flip would show "on" for a client the
 * server refused.
 */
export function createAdbReverseStore(connection: DashboardConnection, options: { pendingTimeoutMs?: number } = {}) {
  const pendingTimeoutMs = options.pendingTimeoutMs ?? PENDING_TIMEOUT_MS;

  return create<AdbReverseStoreState>((set, get) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    connection.onMessage((message) => {
      if (message.type !== 'adbReverseState') return;
      clearTimer();
      set({
        info: {
          enabled: message.enabled,
          usbDevices: message.usbDevices,
          port: message.port,
          canChange: message.canChange,
        },
        pending: false,
      });
    });

    return {
      info: null,
      pending: false,
      setEnabled: (enabled) => {
        const { info, pending } = get();
        if (!info?.canChange || pending) return;
        set({ pending: true });
        connection.send({ type: 'setAdbReverse', enabled });
        clearTimer();
        timer = setTimeout(() => set({ pending: false }), pendingTimeoutMs);
      },
    };
  });
}
