# Detour
A terminal-first, lightweight HTTP debugging proxy for mobile and web. A modern CLI alternative to Charles Proxy with real-time web dashboard.

## Getting Started

### Homebrew (recommended)

This repo is private, so the formula's release-asset download needs a GitHub token (`repo` scope) — set this once, e.g. in your shell profile:

```bash
export HOMEBREW_GITHUB_API_TOKEN="$(gh auth token)"  # or any token with `repo` scope
```

Then:

```bash
brew install rwadada/detour/detour
detour start --port 8080
```

This installs from [rwadada/homebrew-detour](https://github.com/rwadada/homebrew-detour) (public tap, private source repo), which ships a self-contained release build — no `npm install` or Node toolchain setup required beyond Node itself (pulled in automatically as the formula's dependency).

### From source

```bash
npm install
npm run build
npm start -- start --port 8080
```

`npm start --` runs the `detour` command (`bin/detour.js`). If installed globally, `detour start` does the same thing.

- `--port <number>`: Port the proxy listens on (default: `8080`)
- `--dashboard-port <number>`: Port the web dashboard listens on (default: `--port` + `1000`, e.g. `9080` for the default proxy port `8080`)
- `--rules <path>`: Path to a rules file. When given, mock/route/rewrite rules are applied to matching requests (see below). Changes to the file are detected and reloaded automatically. When omitted, `passthrough.rule.json` in the current directory is loaded automatically if present
- `--dump <level>`: Verbosity of the request/response log (default: `summary`, one line per exchange, as today). `full` additionally prints each exchange's headers and body to the console; `file` skips the console spam and instead writes that same dump to its own file under `~/.detour/dumps`, one file per exchange (overwritten as it moves from request to response). Both `full` and `file` redact sensitive headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`) as `[REDACTED]`; a JSON body is pretty-printed, anything else is shown as raw text
- `--no-http2`: Disables HTTP/2 (ALPN) on MITM'd HTTPS connections, falling back to HTTP/1.1 only. HTTP/2 is negotiated with the client by default — shown as `HTTP/2: on`/`off` in the startup banner, and tagged `[h2]` in the log/dashboard for exchanges that negotiated it. The connection to the real upstream server is always HTTP/1.1 either way
- `--no-open`: skips auto-opening the dashboard in your default browser after startup (on by default; see [Web dashboard](#web-dashboard) below). Has no effect under `--headless`
- `--proto <path>`: Path to a `.proto` file used to decode gRPC (`application/grpc*`) message bodies in the console/file dump (`--dump full`/`file`), pretty-printing them instead of showing the raw protobuf-encoded bytes. Repeatable for a schema split across multiple files sharing imports. This is a CLI-dump-only feature for now — the web dashboard's body viewer doesn't decode gRPC yet and shows it as raw bytes there

On first run, a local CA root certificate is generated at `~/.detour/certs/certs/ca.pem`. To decrypt HTTPS traffic, install this certificate as a trusted root certificate on your target browser/OS/device. `detour cert export [path]` writes it to `<path>` (or stdout, if omitted) — generating it first if this is the very first time Detour has run on this machine — for scripting that install rather than digging into `~/.detour/certs` by hand.

Where to install it, and the gotchas that specifically bite this step:
- **macOS**: `detour cert export ~/detour-ca.pem`, then double-click it to add it to Keychain Access, open it there, expand **Trust**, and set **When using this certificate** to **Always Trust**. Just adding it isn't enough — without this step macOS keeps it untrusted and HTTPS traffic through it will fail.
- **Windows**: export it, then `certmgr.msc` → **Trusted Root Certification Authorities** → **Certificates** → right-click → **All Tasks → Import…** and select the file.
- **iOS (physical device)**: AirDrop or email the exported file to the device and install the profile via **Settings → General → VPN & Device Management**. This alone isn't enough either — iOS installs it as *un*trusted for TLS until you separately flip it on under **Settings → General → About → Certificate Trust Settings**. Missing this second step is the single most common reason "nothing shows up" for HTTPS on iOS.
- **Android**: **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**. Since Android 7 (API 24), apps don't trust user-added CAs by default unless they explicitly opt in via a `network_security_config` — so some apps (especially ones with their own certificate pinning) still won't show decrypted traffic even once the cert is installed; a rooted device installing the cert into the *system* store instead is the more reliable path for those.
- **Simulators/emulators**: usually easiest — most accept a user-installed CA the same way a real device's OS does, without the pinning restrictions some individual apps add.

Once started, point an HTTP/HTTPS client at the `--port` you chose (e.g. `curl -x http://localhost:8080 https://example.com`, or your device's Wi-Fi proxy settings) and requests passing through will be logged to the console — and appear live in the web dashboard.

During development, run `npm run dev` to watch and run the TypeScript sources directly.

### Checks

- `npm run format:check` / `npm run format`: Biome — check or auto-fix formatting across `src/` and `web/src/`
- `npm run typecheck`: type-checks both the CLI and the dashboard
- `npm run lint`: ESLint (`typescript-eslint` + `eslint-plugin-sonarjs`, plus `@vitest/eslint-plugin` on test files — catches an assertion-free test or a `.skip`/`.only` left in) across `src/` and `web/src/`
- `npm run dep-cruise`: dependency-cruiser — fails on circular imports (each package's own module graph, since they don't import across the `src`/`web` boundary)
- `npm run dup-check`: jscpd — fails if duplicated code exceeds the configured threshold (see `.jscpd.json` for what's already accounted for, e.g. `ringBuffer.ts`'s intentional backend/frontend mirror)
- `npm test` / `npm run test:coverage`: the CLI package's unit tests (Vitest, `src/**/*.test.ts` — pure rule-engine logic: matching, schema validation, mock/route/rewrite helpers). `test:coverage` additionally enforces branch (C1) coverage ≥85% on that same pure-logic surface (see `vitest.config.ts`'s `coverage.include`)
- `npm run test:e2e`: spawns the real CLI (`tsx src/cli.ts start`, no build needed) against a real HTTP server and a real socket — catches the class of bug unit tests structurally can't (see `vitest.e2e.config.ts`)
- `npm run knip`: finds unused files/exports/dependencies. Not part of `verify` — it's repo-wide and can surface pre-existing issues unrelated to the current change, so it's a periodic/manual check rather than a per-turn gate
- `npm run test:mutation`: Stryker Mutator — checks whether the unit suite actually *catches* bugs (mutates a condition/operator/literal, expects a test to fail) rather than just executing lines. Also not part of `verify`: it re-runs the suite once per mutant, so it's minutes rather than seconds — run it periodically or in CI
- `npm run verify`: format:check + typecheck + lint + lint:fsd + dep-cruise + dup-check + test:coverage + test:web + test:e2e, in order — this is what `.claude/hooks/verify-stop.sh` runs automatically after every Claude Code turn (see `.claude/settings.json`), and what `.github/workflows/pr.yml` runs in CI on every push/PR (issue #53)
- `npm run build:release`: builds the self-contained tarball published to GitHub Releases and consumed by the Homebrew formula (issue #52, see `scripts/build-release.mjs`) — bundles the CLI into a single file with esbuild alongside the built dashboard, so installing needs nothing beyond a `node` binary. `.github/workflows/release.yml` runs this on every `vX.Y.Z` tag push

## Web dashboard

`detour start` serves a real-time dashboard at `http://localhost:9080` by default (`--port` + `1000`; or whatever `--dashboard-port` is set to) for browsing captured traffic without leaving the browser, and opens it in your default browser automatically once it's ready. Pass `--no-open` to skip that (it's also skipped automatically under `--headless`, when the dashboard hasn't been built yet, or for an ephemeral `--dashboard-port 0`).

- Every request/response streams into the log table live over a WebSocket as it passes through the proxy; a bounded backlog (last 500 exchanges) is replayed on connect so refreshing the page doesn't lose recent history
- The table is virtualized (`@tanstack/react-virtual`), so it stays smooth with thousands of rows
- Filter by method, status class, or a URL substring; click a row to inspect its request/response headers, query params, and body (pretty-printed JSON where applicable) in the resizable side panel
- Request/response bodies are captured up to 256 KB per exchange (larger bodies are still proxied in full — only the captured copy shown in the dashboard is truncated)
- An exchange paused by a `breakpoint` rule (see below) shows up live with a "paused" indicator; opening it lets you edit its method/path/headers/body (or status/headers/body, for a paused response) and either resume it or abort it outright
- The "Intercept On/Off" toggle in the header is a master switch for the rule engine, live for the whole proxy (every connected dashboard tab stays in sync). Turning it off drops the proxy to a plain relay: HTTPS becomes a raw TLS passthrough (no MITM decryption — traffic isn't observable and a `mock`/`rewrite`/`breakpoint` rule can't touch it), and on plain HTTP those same rule types are skipped. A `route` rule keeps redirecting the destination host either way
- The "Focus" control in the header narrows interception down to a host allowlist instead of an all-or-nothing switch: with one or more `*`/`?` glob patterns added (e.g. `*.example.com`, or `localhost:3000` to target a non-default port), only a matching host is MITM-decrypted/intercepted — every other host gets exactly the "Intercept Off" treatment described above, scoped to just that host. Empty (the default) means unrestricted, identical to Focus not existing. Also live for the whole proxy and synced across every connected tab
- The "Throttle" control in the header simulates degraded network conditions — bandwidth cap, latency, packet loss — on proxied traffic, for testing how a client behaves on a slow/lossy connection. Off by default (a true no-op); pick the "Fast 3G"/"Slow 3G" preset or set Download/Upload (Kbps), Latency (ms), and Packet loss (%) directly (`0` = unlimited/none). Also live for the whole proxy and synced across every connected tab. On the MITM'd HTTP(S) path a throttled body is delivered in one delayed write rather than trickled out progressively (a limitation of the underlying proxy library), and it's bypassed by `mock`/`breakpoint` responses and by a body a `rewrite` rule is also rewriting (only Latency still applies to those) — the raw byte-level CONNECT tunnel used while Intercept/Focus is off throttles genuinely chunk-by-chunk instead
- The "Block Hosts" control in the header outright denies requests to a set of `*`/`?` glob host patterns (issue #14), for simulating a host being unreachable. Empty by default (a true no-op); add host patterns (e.g. `*.example.com`, or `localhost:3000` for a non-default port — matched the same way as Focus) and pick a mode: `403 Forbidden` responds immediately without ever contacting the real server (a CONNECT tunnel gets a `403` status line before it's ever established), or `Connection reset` drops the connection instead, with no response at all. Checked before every other feature — Intercept off, Focus, and even a `route` rule never get a chance to run for a blocked host. Also live for the whole proxy and synced across every connected tab
- Export the log as HAR 1.2 (for other HTTP-debugging tools) or as Detour's own JSON (re-importable here) — respects whatever filter is currently narrowing the table down, so grabbing just the one failing request for a bug report doesn't drag along everything else that happened to be captured alongside it
- "Save session" snapshots the full captured log *and* the live proxy environment (Intercept/Focus/Throttle/Block Hosts) into one file; "Load session…" restores both — reopening it later resumes the exact conditions it was captured under, not just the traffic
- Ctrl/Cmd-click two rows to mark them for Compare, then diff their headers/bodies side by side
- Copy any request as a ready-to-run `curl` command, or replay it as-is back through the proxy
- Rule Profiles (in the sidebar) save the active `rules.json` as a named, switchable ruleset — handy for flipping between e.g. a `staging` and `production` rule set without hand-editing the file each time
- "Group by host" collapses the log table into per-host sections; the "Tail" toggle pauses auto-scroll so new traffic doesn't yank you away from a row you're reading

The dashboard's source lives in [`web/`](./web) (React 19 + Vite + Tailwind CSS + Zustand) and is built to `web-dist/`, which `npm run build` produces alongside the CLI's `dist/`. To iterate on the UI with `npm run dev:dashboard` (Vite's dev server with hot reload) instead of rebuilding, run `detour start` in one terminal and `npm run dev:dashboard` in another — Vite proxies `/ws` through to the default dashboard port.

## Daemon mode, CI, and automation (issue #20)

A handful of `start` flags and top-level commands exist specifically for running Detour unattended — from a CI pipeline or test harness, or as a long-lived background process — rather than in an interactive terminal.

- `--headless`: skips starting the web dashboard entirely (proxy-only) — for a run where nothing is going to open the dashboard in a browser anyway
- `--exit-on-idle <ms>`: exits automatically once this many milliseconds pass with no proxied HTTP/WebSocket activity, so a CI job never needs to send it a `Ctrl+C` of its own
- `--fail-on-running`: exits with code `3` instead of starting if detour is already tracked as running on the same `--port`, rather than the generic port-in-use error — lets a script tell "already running" apart from any other startup failure
- `--detach`: starts as a background daemon and returns only once it's actually ready to serve traffic, instead of blocking the terminal. Its output goes to `~/.detour/logs/<port>.log` instead of the console. Manage it afterwards with:
  - `detour status --port <port>`: reports whether an instance (detached or foreground) is running on `<port>` — its PID, proxy/dashboard URLs, and start time
  - `detour stop --port <port>`: stops it (`SIGTERM`, escalating to `SIGKILL` after a 10s grace period) — works on a foreground instance too, not just a detached one
- `--foreground`: forces this one `start` to run in the foreground even if `defaultDetach` (below) is on — the opposite of `--detach`
- Every successful `start` — detached or not — prints a `DETOUR_READY proxyPort=<n> [dashboardPort=<n>] pid=<n>` line once the proxy (and dashboard, unless `--headless`) has actually bound its port(s), so a script can wait on that line instead of guessing how long startup takes

`--fail-on-running`/`--detach`/`status`/`stop` are all keyed by the `--port` value given to `start` — an ephemeral `--port 0` has no stable value to be looked up by later, so combining it with `--fail-on-running` or `--detach` is rejected outright.

If you always want `start` to run detached, `detour config --default-detach on` persists that to `~/.detour/config.json` so plain `detour start` (no `--detach`) runs detached from then on — override it back for one run with `--foreground`, or turn it off again with `detour config --default-detach off`. Running `detour config` alone prints the current value.

## Rule engine (rules.json)

Traffic routing, rewriting, and mock substitution can be declared declaratively.

```bash
detour rules init          # generate a sample rules.json
detour rules validate rules.json  # check its schema/consistency
detour start --rules rules.json   # start the proxy with rules applied
```

A rules file is an array of rules, evaluated in order for each request. The first enabled rule that matches wins and its action is applied (later rules are not evaluated).

```json
{
  "rules": [
    {
      "name": "mock-users",
      "match": { "method": "GET", "url": "https://api.example.com/users/*" },
      "action": { "type": "mock", "status": 200, "body": { "id": 1, "name": "Mock User" } }
    }
  ]
}
```

- `match.url`: a wildcard pattern supporting `*` (any run of characters) and `?` (any single character). `match.urlRegex` (with optional `urlRegexFlags`) matches with a regular expression instead (specify exactly one of `url`/`urlRegex`). `method` matches any method if omitted
- `action.type: "mock"`: responds immediately with the given status/headers/body — without ever contacting the real server (`body` is JSON-serialized for objects/arrays, sent verbatim for strings; `bodyFile` returns a file's contents instead). `delayMs` adds an artificial delay before responding. `simulate: "close"`/`"timeout"` drops the connection instead of ever sending a response — `close` resets it immediately, `timeout` just leaves it hanging until the client's own timeout fires — and takes precedence over `status`/`headers`/`body`/`bodyFile` when set
- `action.type: "route"`: redirects the request's destination host/port (`preserveHostHeader: false` also rewrites the Host header)
- `action.type: "rewrite"`: for `request`/`response` independently, adds/removes headers (`headers.set`/`headers.remove`) and rewrites the body (`body.set` replaces it wholesale; `body.replace` does sequential string/regex substitution; `body.merge` applies a JSON Merge Patch, RFC 7396 — a `null` value deletes a key, everything else deep-merges). `request.query` (`query.set`/`query.remove`) additionally adds/removes URL query string parameters — there's no `response.query` since a response has no URL
- `action.type: "breakpoint"`: pauses a matching exchange instead of letting it flow straight through, so it can be inspected and edited live from the dashboard before continuing (or aborting it outright). `request`/`response` (both default `true`) independently control which phase(s) pause — a request-phase pause exposes method/path/headers/body for editing before it's sent upstream; a response-phase pause exposes status/headers/body for editing before it's returned to the client. A pause waits indefinitely for the dashboard (there's no timeout), so only enable it on rules you're actively debugging with the dashboard open
- `action.type: "script"`: runs a `beforeRequest`/`beforeResponse` hook from a CommonJS module at `path` (resolved relative to rules.json) for transformations the declarative actions above can't express. Each hook is optional — a module with only one of them leaves the other phase untouched — and may be `async`:
  ```js
  // rules.script.js
  module.exports = {
    beforeRequest(req) {
      // req: { method, url, headers, body: Buffer }. Return a partial
      // { method?, headers?, body? } — omitted fields keep their original
      // value; return undefined/null (or nothing) to leave the request as-is.
      return { headers: { ...req.headers, 'X-Detour': '1' } };
    },
    async beforeResponse(req, res) {
      // res: { status, statusMessage, headers, body: Buffer }. Return a
      // partial { status?, statusMessage?, headers?, body? }, same rule.
      return { body: res.body.toString('utf8').replace('"pending"', '"confirmed"') };
    },
  };
  ```
  `body` may be returned as a `Buffer` or a `string` either way, and is always the full, untruncated body — unlike the dashboard's own display copy of an exchange, it's never cut off at the 256 KiB capture cap. Response `headers` values may be a `string` or a `string[]` (a repeated header like `Set-Cookie` is kept as an array — set one back the same way rather than joining it with commas, which would corrupt it). A hook that throws (or whose returned promise rejects) leaves that phase forwarded untouched and logs the error, rather than dropping the exchange. The script itself is reloaded automatically when its file changes, the same as rules.json. See [`example.script.js`](./example.script.js) for a complete, runnable example.

Editing a rules file while the proxy is running triggers an automatic reload (if validation fails, the previous rules keep serving traffic and the error is printed to the console).

The repository ships two rules files for different purposes at its root:

- [`passthrough.rule.json`](./passthrough.rule.json): has no rules at all — a true no-op. `detour start` (without `--rules`) auto-detects it in the current directory, guaranteeing the proxy behaves as a plain passthrough by default
- [`example.rule.json`](./example.rule.json) (plus the [`example.mock-body.json`](./example.mock-body.json) and [`example.script.js`](./example.script.js) it references): a reference implementation touching every mock/route/rewrite/breakpoint/script option. All rules are `enabled: false`, so it's safe to copy and adapt. Try it with `detour start --rules example.rule.json` (after enabling the rule(s) you want)

### Known issues
- WebSocket-over-HTTP/2 ([RFC 8441](https://datatracker.ietf.org/doc/html/rfc8441) extended CONNECT) isn't supported — a WebSocket connection to a host also using HTTP/2 for its regular traffic still works, but negotiates plain HTTP/1.1 for the WebSocket connection itself (as browsers typically do anyway).

### Proxy core
The MITM proxy engine (CONNECT tunneling, on-the-fly per-host TLS certs, HTTP/1.1 and HTTP/2 forwarding — [`src/infra/proxy/engine/`](./src/infra/proxy/engine/)) is a from-scratch implementation on top of Node's own `http`/`https`/`http2`/`tls`/`net` modules and `node-forge` for certificate signing, rather than a third-party MITM library (issue #42) — this avoids depending on a library patched for macOS support and HTTP/2, and allows the request/response pipeline to genuinely stream/throttle chunk-by-chunk instead of buffering whole bodies.
