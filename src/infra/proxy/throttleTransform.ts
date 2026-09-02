import { Transform } from 'node:stream';
import { BandwidthState, transferDelayMs } from '../../domain/throttle/bandwidth';

/**
 * A `Transform` that re-emits each chunk after `transferDelayMs`'s delay,
 * spliced into a raw `Duplex.pipe()` chain (the intercept-off CONNECT
 * tunnel). Real Node stream backpressure applies here — piping through a
 * Transform correctly holds the source until this delay elapses — unlike
 * http-mitm-proxy's own onRequestData/onResponseData hooks, whose internal
 * filter doesn't honor a delayed per-chunk callback the same way (see the
 * buffer-then-flush comment on the MITM'd request/response paths in
 * proxyServer.ts).
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
