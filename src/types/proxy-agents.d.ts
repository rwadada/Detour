/**
 * Ambient module declarations for `http-proxy-agent`/`https-proxy-agent`/
 * `socks-proxy-agent` (issue #145's `--upstream-proxy`) — these packages
 * ship only a modern `exports` map with no top-level `main` field, which
 * this project's `moduleResolution: "Node10"` (see tsconfig.json's own doc
 * comment on why it hasn't migrated off that yet) can't follow at all,
 * failing with "Cannot find module" despite real `.d.ts` files sitting
 * right there in `node_modules`. A hand-written ambient declaration for
 * the exact shape `src/infra/proxy/upstreamProxyAgent.ts` actually uses
 * sidesteps that resolution gap entirely, module resolution for these
 * three specifiers included.
 *
 * Declared as extending `http.Agent` directly (not each package's own
 * `agent-base`-derived ancestor) since that's the only part of their real
 * type that code here needs — Node's `http`/`https` modules duck-type an
 * `agent:` option at runtime rather than checking its prototype chain, so
 * this doesn't change actual behavior, only what TypeScript is told about it.
 */

declare module 'http-proxy-agent' {
  import http from 'node:http';

  export class HttpProxyAgent extends http.Agent {
    constructor(proxy: string | URL, opts?: http.AgentOptions);
  }
}

declare module 'https-proxy-agent' {
  import http from 'node:http';

  export class HttpsProxyAgent extends http.Agent {
    constructor(proxy: string | URL, opts?: http.AgentOptions);
  }
}

declare module 'socks-proxy-agent' {
  import http from 'node:http';

  export class SocksProxyAgent extends http.Agent {
    constructor(proxy: string | URL, opts?: http.AgentOptions);
  }
}
