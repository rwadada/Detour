/**
 * Shared idle/connect timeout (ms) for every upstream connection this
 * proxy holds open — `ProxyEngine`'s own HTTP/1.1 keep-alive agents
 * (issue #162) and `UpstreamHttp2Pool`'s h2 sessions and ALPN probes
 * (issue #166) alike. Pulled into its own module, rather than each file
 * hardcoding `60_000` with a "mirrors the other one" comment, so the two
 * can't silently drift apart: `proxyEngine.ts` and `upstreamHttp2.ts`
 * already import from each other in the other direction, so neither can
 * re-export a same-file constant to the other.
 */
export const UPSTREAM_KEEP_ALIVE_TIMEOUT_MS = 60_000;
