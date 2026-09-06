import type { SetupTarget } from '../../domain/setup/targets';

/** Targets that are a separate device from the machine running `detour` — they need this machine's LAN IP, not `localhost`. */
const DEVICE_TARGETS: ReadonlySet<SetupTarget> = new Set(['android', 'ios']);

export interface ResolveProxyHostOptions {
  target: SetupTarget;
  /** `--host`, if the caller passed one — always wins, since auto-detection is a guess and a machine with several interfaces may guess the wrong one. */
  hostOverride?: string;
  /** This machine's non-internal IPv4 addresses (`infra/network/lanAddresses.ts`), passed in rather than detected here so this stays a pure, unit-testable decision. */
  detectedLanAddresses: string[];
}

/** Thrown when a device target needs this machine's LAN IP and none could be detected — never silently falls back to `localhost`, which the device couldn't reach. */
export class ProxyHostUnresolvedError extends Error {}

/**
 * Decides what address to tell `target` to point its HTTP/HTTPS proxy at.
 * A target that *is* this machine (mac/linux/windows) uses `localhost`; a
 * separate device (android/ios) needs this machine's LAN IP instead, since
 * `localhost` on the device would mean the device itself.
 *
 * This is about what to *advertise*, not whether `target`'s automation can
 * run at all — `ios` is a device target here because a *physical* iPhone
 * genuinely does need a LAN IP for its manual proxy instructions, but ios's
 * real automation (trusting the CA cert on a Simulator, which shares this
 * Mac's own network) never calls this at all. `orchestrator.ts` lets ios
 * through even when this throws, precisely so an unresolvable LAN IP can't
 * block Simulator automation that never needed one (see its own comment on
 * `runForTarget`'s `catch`, and `ios.ts`'s `physicalDeviceSteps`, which
 * degrades its printed instructions gracefully instead).
 */
export function resolveProxyHost(options: ResolveProxyHostOptions): string {
  if (options.hostOverride) return options.hostOverride;
  if (!DEVICE_TARGETS.has(options.target)) return 'localhost';
  const [first] = options.detectedLanAddresses;
  if (!first) {
    throw new ProxyHostUnresolvedError(
      `Couldn't detect this machine's LAN IP to advise the ${options.target} device to connect to (no non-internal network interface found) — connect this machine to Wi-Fi/Ethernet, or pass --host <ip> explicitly.`,
    );
  }
  return first;
}
