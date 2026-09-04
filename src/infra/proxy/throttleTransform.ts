import { Transform } from 'node:stream';
import { BandwidthState, transferDelayMs } from '../../domain/throttle/bandwidth';

/**
 * A `Transform` that re-emits each chunk after `transferDelayMs`'s delay,
 * spliced into a raw `Duplex.pipe()` chain (the intercept-off CONNECT
 * tunnel — raw bytes below any HTTP parsing, so `ctx.onRequestData`/
 * `onResponseData` in proxyServer.ts's MITM'd request/response paths don't
 * apply here). Real Node stream backpressure applies — piping through a
 * Transform correctly holds the source until this delay elapses.
 */
export function createThrottleTransform(kbps: number, packetLossPct: number): Transform {
  const bandwidth = new BandwidthState();
  return new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      const delay = transferDelayMs(chunk.length, kbps, packetLossPct, bandwidth);
      if (delay > 0) setTimeout(() => cb(null, chunk), delay);
      else cb(null, chunk);
    },
  });
}
