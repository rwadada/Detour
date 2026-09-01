# Detour
A terminal-first, lightweight HTTP debugging proxy for mobile and web. A modern CLI alternative to Charles Proxy with real-time web dashboard.

## Getting Started

```bash
npm install
npm run build
npm start -- start --port 8080 --dashboard-port 4040
```

`npm start --` runs the `detour` command (`bin/detour.js`). If installed globally, `detour start` does the same thing.

- `--port <number>`: Port the proxy listens on (default: `8080`)
- `--dashboard-port <number>`: Port reserved for the web dashboard (default: `4040`; the dashboard itself isn't implemented yet — planned for a future issue)
- `--rules <path>`: Path to a rules file. When given, mock/route/rewrite rules are applied to matching requests (see below). Changes to the file are detected and reloaded automatically. When omitted, `passthrough.rule.json` in the current directory is loaded automatically if present

On first run, a local CA root certificate is generated at `~/.detour/certs/certs/ca.pem`. To decrypt HTTPS traffic, install this certificate as a trusted root certificate on your target browser/OS/device.

Once started, point an HTTP/HTTPS client at the `--port` you chose (e.g. `curl -x http://localhost:8080 https://example.com`, or your device's Wi-Fi proxy settings) and requests passing through will be logged to the console.

During development, run `npm run dev` to watch and run the TypeScript sources directly.

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
- `action.type: "mock"`: responds immediately with the given status/headers/body — without ever contacting the real server (`body` is JSON-serialized for objects/arrays, sent verbatim for strings; `bodyFile` returns a file's contents instead)
- `action.type: "route"`: redirects the request's destination host/port (`preserveHostHeader: false` also rewrites the Host header)
- `action.type: "rewrite"`: for `request`/`response` independently, adds/removes headers (`headers.set`/`headers.remove`) and rewrites the body (`body.set` replaces it wholesale, `body.replace` does string/regex substitution)

Editing a rules file while the proxy is running triggers an automatic reload (if validation fails, the previous rules keep serving traffic and the error is printed to the console).

The repository ships two rules files for different purposes at its root:

- [`passthrough.rule.json`](./passthrough.rule.json): has no rules at all — a true no-op. `detour start` (without `--rules`) auto-detects it in the current directory, guaranteeing the proxy behaves as a plain passthrough by default
- [`example.rule.json`](./example.rule.json) (plus the [`example.mock-body.json`](./example.mock-body.json) it references): a reference implementation touching every mock/route/rewrite option. All rules are `enabled: false`, so it's safe to copy and adapt. Try it with `detour start --rules example.rule.json` (after enabling the rule(s) you want)

### Known issues
- `http-mitm-proxy@1.1.0` has a bug on macOS/BSD where the HTTPS (CONNECT) tunnel fails with `ECONNREFUSED` (it hardcodes the destination host to `0.0.0.0` internally). This is fixed via `patches/http-mitm-proxy+1.1.0.patch` (applied automatically on `npm install` via `patch-package`).

# Scratch notes
## Planned command set

detour start  
detour start --detach  
detour status  
detour stop  
detour stop --cleanup : stop + undo setup  
detour view <file> : launch the viewer  
detour setup  
detour cleanup  
detour doctor  
detour settings  
detour rules init  
detour rules edit  
detour rules validate  
detour rules use  
detour session save/load/list  
detour cert export  

## Main options for `start`
--detach  
--rules <path>  
--port <number>  
--ui-port <number>  
--ui-lan : expose the dashboard on the LAN  
--no-open  
--no-ui  
--headless  
--exit-on-idle  
--fail-on-running  
--dump <level>  

## Setup
something like `detour setup --target android`
