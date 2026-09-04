/**
 * Extra stall (ms) applied to a chunk "lost" under Throttle's
 * `packetLossPct`. This is an HTTP-level proxy, not a raw packet filter —
 * actually dropping bytes here would just corrupt the body — so loss is
 * approximated as the stall a real TCP retransmit timeout would cause
 * instead of an literal drop (see `ThrottleState`'s doc comment).
 */
export const RETRANSMIT_DELAY_MS = 300;

/**
 * Per-exchange, per-direction token bucket backing Throttle's bandwidth cap:
 * spaces consecutive chunks out so their aggregate throughput matches
 * `kbps`, rather than just delaying each chunk independently (which would
 * let a burst of small chunks straight through). Each exchange/direction
 * gets its own instance, so concurrent exchanges are throttled
 * independently rather than sharing one simulated pipe.
 */
export class BandwidthState {
  private nextTime = 0;

  /**
   * Delay (ms, ≥0) before a chunk of `byteLength` bytes may go out, given
   * `kbps` (0 = unlimited). Advances internal state so a later call's delay
   * accounts for this chunk having "used up" its share of the bucket.
   */
  delayFor(byteLength: number, kbps: number): number {
    if (kbps <= 0) return 0;
    const bytesPerMs = (kbps * 1000) / 8 / 1000;
    const now = Date.now();
    // This chunk starts transmitting once the link is free (either now, or
    // once the previous chunk finished) and takes `byteLength / bytesPerMs`
    // to finish — the caller should wait until *that* point, not just until
    // this chunk's turn starts, or a lone/first chunk would see 0 delay
    // despite genuinely taking time to "transmit" at the capped rate.
    const start = Math.max(now, this.nextTime);
    this.nextTime = start + byteLength / bytesPerMs;
    return Math.max(0, this.nextTime - now);
  }
}

/** Combines bandwidth pacing and simulated packet loss into one delay (ms) for `byteLength` bytes of transferred data — see `BandwidthState` and `RETRANSMIT_DELAY_MS`. */
export function transferDelayMs(
  byteLength: number,
  kbps: number,
  packetLossPct: number,
  bandwidth: BandwidthState,
): number {
  let delay = bandwidth.delayFor(byteLength, kbps);
  // Simulated packet loss, purely for local network-condition testing — not
  // security-sensitive, so Math.random()'s non-cryptographic PRNG is fine.
  // eslint-disable-next-line sonarjs/pseudo-random
  if (packetLossPct > 0 && Math.random() * 100 < packetLossPct) delay += RETRANSMIT_DELAY_MS;
  return delay;
}
