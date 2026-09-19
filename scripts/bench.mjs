#!/usr/bin/env node
'use strict';

// Benchmark harness for the proxy's request hot path (issue #163).
//
// README calls Detour "lightweight", but nothing in the repo measured that
// until this script: `npm run verify` is thorough about correctness and says
// nothing about speed, which is how #162's missing connection reuse survived
// unnoticed. This measures the paths a refactor can silently slow down —
// TLS termination, cert issuance, rule matching, body rewriting, capture +
// dashboard broadcast, and large-body streaming.
//
// The number that matters is the LAST column, not req/s: every scenario is
// compared against the same request made without Detour in the middle
// (scenario 8), measured in the same process on the same machine moments
// apart. An absolute req/s says more about the machine than about Detour; a
// ratio survives being run on a noisy CI runner.
//
// Load client: hand-rolled on node:http(s) + https-proxy-agent (already a
// runtime dependency, for --upstream-proxy) rather than autocannon, which
// the issue originally suggested. autocannon can only point at a URL: it has
// no CONNECT support, and five of the eight scenarios are HTTPS *through*
// the proxy, which is exactly a CONNECT tunnel. A client that can't measure
// the MITM path can't measure the thing this harness exists for.
//
// Deliberately NOT part of `npm run verify` — it takes minutes and its
// numbers move with the machine, the same reason `knip` and `test:mutation`
// sit outside the per-turn gate.
//
// Usage:
//   npm run bench                          # all scenarios
//   npm run bench -- --scenarios 1,2,8     # a subset
//   npm run bench -- --quick               # CI-sized: short, scenarios 1,2,5
//   npm run bench -- --json out.json       # save results
//   npm run bench -- --compare a.json b.json   # diff two saved runs
//   npm run bench -- --gate                # exit 1 if overhead exceeds the ceiling

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import forge from 'node-forge';
import WebSocket from 'ws';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const detourEntry = path.join(repoRoot, 'bin/detour.js');

const KB = 1024;
const MB = 1024 * KB;

/**
 * `--gate` ceilings, as a multiple of the same request made with no proxy in
 * the middle. Per scenario rather than one global number, because the three
 * differ by 3x today and a single ceiling loose enough for the slowest would
 * never catch a regression in the fastest.
 *
 * These are tripwires for a change that makes the hot path multiples slower,
 * not targets to tune against, so each sits at roughly 2x its observed
 * maximum over repeated local runs (scenario 1: 14-21x, 2: 45-69x, 5:
 * 50-61x). The spread is that wide because the denominator is a sub-
 * millisecond loopback request: a 0.2 ms wobble in the baseline moves the
 * ratio by tens. A tighter bound would fail on noise and get ignored, which
 * is worse than a loose one that only fires on something real.
 *
 * The ratios themselves are high because the baseline reuses one keep-alive
 * connection while the proxy opens a fresh TCP+TLS connection upstream for
 * every single request (#162). Tighten these once that lands — the whole
 * point of having numbers is to be able to.
 */
const GATE_MAX_P95_RATIO = { 1: 45, 2: 150, 5: 150 };

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

/**
 * `rules` names a generator below rather than a file: each scenario gets a
 * freshly written rules.json in a temp dir, so running a subset behaves the
 * same as running everything.
 */
const SCENARIOS = [
  { id: 1, name: 'HTTP passthrough', scheme: 'http', bodyBytes: KB, purpose: 'baseline proxy overhead' },
  { id: 2, name: 'HTTPS (MITM) passthrough', scheme: 'https', bodyBytes: KB, purpose: 'TLS termination + cert reuse' },
  {
    id: 3,
    name: 'HTTPS + 100 non-matching rules',
    scheme: 'https',
    bodyBytes: KB,
    rules: 'noise',
    purpose: 'rule matching cost',
  },
  {
    id: 4,
    name: 'HTTPS + rewrite rule applied',
    scheme: 'https',
    bodyBytes: KB,
    rules: 'rewrite',
    purpose: 'body rewrite cost',
  },
  {
    id: 5,
    name: 'HTTPS + dashboard connected',
    scheme: 'https',
    bodyBytes: KB,
    dashboard: true,
    purpose: 'capture + WS broadcast cost',
  },
  { id: 6, name: 'HTTPS streaming (10 MB body)', scheme: 'https', bodyBytes: 10 * MB, purpose: 'streaming throughput' },
  {
    id: 7,
    name: 'HTTPS to 100 fresh hosts',
    scheme: 'https',
    bodyBytes: KB,
    rules: 'routeHosts',
    freshHosts: 100,
    purpose: 'per-host cert issuance',
  },
  // Scenario 8 isn't listed here: it's the no-proxy baseline, and the harness
  // measures one per distinct (scheme, body size) the selected scenarios
  // actually use, so every ratio compares like with like.
];

const QUICK_SCENARIOS = [1, 2, 5];

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

/**
 * Rejects a flag value that isn't a positive number. Unvalidated, `Number()`
 * turns a typo into `NaN` and the run reports a confident `0 req/s` row
 * instead of failing — a benchmark that quietly measures nothing is worse
 * than one that refuses to start.
 */
function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number (got: ${value})`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    scenarios: SCENARIOS.map((s) => s.id),
    durationMs: 10_000,
    connections: 8,
    warmupMs: 2_000,
    json: undefined,
    compare: undefined,
    gate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--scenarios') options.scenarios = next().split(',').map(Number);
    else if (arg === '--duration') options.durationMs = positiveNumber(next(), arg) * 1000;
    else if (arg === '--connections') options.connections = positiveNumber(next(), arg);
    else if (arg === '--json') options.json = path.resolve(next());
    else if (arg === '--compare') options.compare = [path.resolve(next()), path.resolve(next())];
    else if (arg === '--gate') options.gate = true;
    else if (arg === '--quick') {
      options.scenarios = QUICK_SCENARIOS;
      options.durationMs = 3_000;
      options.warmupMs = 1_000;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Upstream under test
// ---------------------------------------------------------------------------

/**
 * A throwaway CA + leaf for the HTTPS upstream, generated per run rather than
 * committed: this is the *origin server's* certificate, nothing to do with
 * Detour's own MITM CA. Detour is told to trust it via NODE_EXTRA_CA_CERTS,
 * so the upstream leg verifies for real instead of being measured with
 * verification disabled (which it is not — see `makeProxyToServerRequest`).
 */
function generateUpstreamCert() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(Date.now() - 60_000);
  caCert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: 'commonName', value: 'detour-bench-upstream-ca' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date(Date.now() - 60_000);
  leafCert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  leafCert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  leafCert.setIssuer(caAttrs);
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    // type 2 = DNS name, type 7 = IP.
    //
    // `*.bench.invalid` is what makes scenario 7 work: its route rule sends
    // the upstream request to 127.0.0.1, but the SNI/servername stays the
    // original `host-N.bench.invalid`, so a cert covering only localhost is
    // rejected by the upstream leg's (real, not disabled) verification.
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: '*.bench.invalid' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

/**
 * Serves `/bytes/<n>` with exactly n bytes. Bodies are pre-allocated once and
 * reused so the upstream never becomes the bottleneck being measured — the
 * point is to time Detour, not this server's allocator.
 */
function startUpstream({ tls, certs }) {
  const bodies = new Map();
  const bodyFor = (size) => {
    let body = bodies.get(size);
    if (!body) {
      body = Buffer.alloc(size, 'a');
      bodies.set(size, body);
    }
    return body;
  };

  const handler = (req, res) => {
    req.resume();
    const match = /^\/bytes\/(\d+)/.exec(req.url ?? '');
    const size = match ? Number(match[1]) : KB;
    const body = bodyFor(size);
    // `application/octet-stream`, not `application/json`: the body is a run
    // of filler bytes, and labelling it JSON would misrepresent it to
    // anyone reading a capture while profiling. Nothing measured here
    // branches on the type — `BodyCapture` counts bytes and is content-type
    // agnostic — so this is honesty, not a change to the workload.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  };

  const server = tls
    ? https.createServer({ cert: certs.certPem, key: certs.keyPem }, handler)
    : http.createServer(handler);
  server.keepAliveTimeout = 60_000;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // Belt and braces alongside the `finally` that closes these in
      // `main`: an idle listening server that is unref'd can't keep the
      // process alive on its own, so even a path that somehow skips that
      // cleanup exits rather than hanging. In-flight request sockets are
      // their own ref'd handles, so this doesn't cut a run short.
      server.unref();
      resolve({ port: server.address().port, close: () => closeServer(server) });
    });
  });
}

function closeServer(server) {
  return new Promise((done) => server.close(() => done()));
}

// ---------------------------------------------------------------------------
// The process under test
// ---------------------------------------------------------------------------

/** Spawns `bin/detour.js start`, resolving once its DETOUR_READY line lands. */
async function startDetour({ rulesPath, dashboard, upstreamCaPath }) {
  const args = [detourEntry, 'start', '--port', '0', '--no-open'];
  if (dashboard) args.push('--dashboard-port', '0');
  else args.push('--headless');
  if (rulesPath) args.push('--rules', rulesPath);

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    // The upstream's throwaway CA (see generateUpstreamCert) — without it the
    // proxy's own upstream leg fails verification and every scenario measures
    // a 502 instead of a proxied request.
    env: { ...process.env, NODE_EXTRA_CA_CERTS: upstreamCaPath },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 30_000;
  while (!/DETOUR_READY /.test(stdout)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`detour start never became ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await sleep(50);
  }

  const ready = /DETOUR_READY proxyPort=(\d+)(?: dashboardPort=(\d+))? pid=(\d+)/.exec(stdout);
  if (!ready) throw new Error(`could not parse DETOUR_READY from:\n${stdout}`);
  const caMatch = /Root CA certificate: (.+)/.exec(stdout);
  if (!caMatch) throw new Error(`could not parse the CA cert path from:\n${stdout}`);

  return {
    proxyPort: Number(ready[1]),
    dashboardPort: ready[2] ? Number(ready[2]) : undefined,
    pid: Number(ready[3]),
    caCertPath: caMatch[1].trim(),
    stop: async () => {
      child.kill('SIGTERM');
      const stopBy = Date.now() + 5_000;
      while (child.exitCode === null && Date.now() < stopBy) await sleep(50);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Peak RSS and CPU seconds burned by the proxy process over a window, read
 * from `ps` rather than from inside the process: the whole point is to see
 * what the binary a user runs costs, and instrumenting it from within would
 * change the thing being measured.
 *
 * Skipped entirely on Windows, which has no `/bin/ps`: spawning a doomed
 * process four times a second would burn real CPU next to the thing being
 * timed, and the resulting skew is a worse outcome than two blank columns.
 * Latency and throughput are measured from this process either way.
 */
const PROCESS_SAMPLING_SUPPORTED = process.platform !== 'win32';

function createProcessSampler(pid) {
  let peakRssMb = 0;
  let firstCpu;
  let lastCpu = 0;

  const sample = () => {
    if (!PROCESS_SAMPLING_SUPPORTED) return;
    try {
      // An absolute path, not a bare `ps` resolved through PATH: it lives
      // here on both Unix platforms that reach this line, and it keeps the
      // lookup out of reach of whatever PATH happens to hold.
      const out = execFileSync('/bin/ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (!out) return;
      const [rssKb, cpuTime] = out.split(/\s+/);
      peakRssMb = Math.max(peakRssMb, Number(rssKb) / 1024);
      const seconds = parseCpuTime(cpuTime);
      if (firstCpu === undefined) firstCpu = seconds;
      lastCpu = seconds;
    } catch {
      // The process is gone (or `ps` is unavailable on this platform) — the
      // latency numbers are still valid, so report what we have instead of
      // failing the whole run over a secondary metric.
    }
  };

  sample();
  const timer = setInterval(sample, 250);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return { peakRssMb, cpuSeconds: firstCpu === undefined ? 0 : lastCpu - firstCpu };
    },
  };
}

/** `ps -o time=` prints `MM:SS.ss` or `HH:MM:SS`, depending on platform and magnitude. */
function parseCpuTime(value) {
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// ---------------------------------------------------------------------------
// Load generation
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One request, body fully drained. Draining matters: scenario 6 moves 10 MB
 * per request, and timing only the response headers would report the
 * streaming scenario as the fastest one here.
 */
function requestOnce({ agent, scheme, host, port, requestPath, ca }) {
  const transport = scheme === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      { host, port, path: requestPath, method: 'GET', agent, ca, servername: scheme === 'https' ? host : undefined },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, bytes }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Builds the per-connection agent. Each worker gets its own with
 * `maxSockets: 1`, so "connections" means what it says instead of letting
 * Node's pool decide, and client-side keep-alive is on for every scenario
 * (a browser's behaviour) — whether the *upstream* leg reuses connections is
 * Detour's business, and precisely what #162 is about.
 */
function createAgent({ proxyUrl, scheme, ca }) {
  if (proxyUrl) {
    // Two different agents on purpose, because they exercise two different
    // proxy code paths: https goes through a CONNECT tunnel that Detour
    // terminates and re-encrypts (the MITM path), http is an absolute-form
    // request the proxy forwards directly.
    return scheme === 'https'
      ? new HttpsProxyAgent(proxyUrl, { keepAlive: true, maxSockets: 1, ca, rejectUnauthorized: true })
      : new HttpProxyAgent(proxyUrl, { keepAlive: true, maxSockets: 1 });
  }
  const Agent = scheme === 'https' ? https.Agent : http.Agent;
  return new Agent({ keepAlive: true, maxSockets: 1, ca });
}

/** Drives `connections` workers until the deadline, collecting per-request latencies. */
async function runLoad({ connections, durationMs, target }) {
  const latencies = [];
  const counters = { errors: 0, bytes: 0 };
  const deadline = performance.now() + durationMs;

  const worker = async () => {
    const agent = createAgent(target);
    try {
      while (performance.now() < deadline) {
        const startedAt = performance.now();
        try {
          const result = await requestOnce({ ...target, agent });
          if (result.status !== 200) recordError(counters, new Error(`HTTP ${result.status} from the proxy`));
          else {
            latencies.push(performance.now() - startedAt);
            counters.bytes += result.bytes;
          }
        } catch (error) {
          recordError(counters, error);
        }
      }
    } finally {
      agent.destroy();
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: connections }, worker));
  return { latencies, counters, elapsedMs: performance.now() - startedAt };
}

/**
 * Scenario 7's shape: a fixed number of distinct hostnames, one request each,
 * so the run times exactly `freshHosts` cert issuances instead of however
 * many happen to fit in a time box.
 */
async function runFreshHosts({ connections, hosts, target }) {
  const latencies = [];
  const counters = { errors: 0, bytes: 0 };
  const queue = [...hosts];

  const worker = async () => {
    for (;;) {
      const host = queue.shift();
      if (!host) return;
      // A fresh agent per host: reusing one would tunnel every host through
      // the same CONNECT and measure nothing.
      const agent = createAgent(target);
      const startedAt = performance.now();
      try {
        const result = await requestOnce({ ...target, host, agent });
        if (result.status !== 200) recordError(counters, new Error(`HTTP ${result.status} from the proxy`));
        else {
          latencies.push(performance.now() - startedAt);
          counters.bytes += result.bytes;
        }
      } catch (error) {
        recordError(counters, error);
      } finally {
        agent.destroy();
      }
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: connections }, worker));
  return { latencies, counters, elapsedMs: performance.now() - startedAt };
}

/**
 * Keeps the first failure's message alongside the count. A scenario whose
 * requests all fail otherwise reports a confident-looking `0 req/s` row and
 * nothing about why — which is exactly how a broken scenario gets mistaken
 * for a slow one.
 */
function recordError(counters, error) {
  counters.errors += 1;
  counters.firstError ??= error instanceof Error ? error.message : String(error);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize({ latencies, counters, elapsedMs }, processStats) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    requests: latencies.length,
    errors: counters.errors,
    firstError: counters.firstError,
    rps: latencies.length / (elapsedMs / 1000),
    throughputMbps: counters.bytes / (elapsedMs / 1000) / MB,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    peakRssMb: processStats?.peakRssMb ?? 0,
    cpuSeconds: processStats?.cpuSeconds ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Rules files
// ---------------------------------------------------------------------------

function writeRules(dir, kind, { upstreamHttpsPort }) {
  const rules = {
    // 100 rules that all fail to match, so the engine walks the whole list on
    // every request — the cost this scenario exists to expose.
    noise: () =>
      Array.from({ length: 100 }, (_, index) => ({
        name: `noise-${index}`,
        match: { url: `https://no-such-host-${index}.invalid/*` },
        action: { type: 'mock', status: 418, body: 'never' },
      })),
    rewrite: () => [
      {
        name: 'bench-rewrite',
        match: { url: '*' },
        action: {
          type: 'rewrite',
          request: { headers: { set: { 'x-bench': '1' } } },
          response: { headers: { set: { 'x-bench-response': '1' } }, body: { replace: [{ find: 'aaa', replacement: 'bbb' }] } },
        },
      },
    ],
    // Scenario 7 asks for 100 hostnames that have never been seen before, but
    // they must not need DNS: the route action sends each one's upstream
    // request to the local server, while the CONNECT still forces a fresh
    // per-host leaf certificate — which is the cost being measured.
    routeHosts: () => [
      {
        name: 'bench-route-hosts',
        match: { url: 'https://*.bench.invalid/*' },
        action: { type: 'route', host: '127.0.0.1', port: upstreamHttpsPort },
      },
    ],
  }[kind]();

  const file = path.join(dir, `${kind}.rules.json`);
  fs.writeFileSync(file, JSON.stringify({ rules }, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

async function connectDashboard(port) {
  // `localhost`, not `127.0.0.1`: the dashboard binds by *hostname*
  // (`resolveDashboardHost` returns 'localhost' without --lan), and this
  // repo's CI runner resolves that to the IPv6 loopback — so a client
  // dialling 127.0.0.1 gets ECONNREFUSED while the server sits on [::1].
  // That is precisely what failed this PR's first readable CI run, and the
  // same trap `detour serve` hit in #149. Connecting by the same name the
  // server bound to sidesteps it, which is what the CLI's own e2e tests do.
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  // Every broadcast frame is read and dropped: an unread socket would let
  // backpressure build in the server and flatter the numbers.
  socket.on('message', () => {});
  return { close: () => socket.close() };
}

async function measureBaseline({ scheme, bodyBytes, upstreams, certs, options }) {
  const target = {
    scheme,
    host: 'localhost',
    port: scheme === 'https' ? upstreams.https.port : upstreams.http.port,
    requestPath: `/bytes/${bodyBytes}`,
    ca: scheme === 'https' ? certs.caPem : undefined,
  };
  await runLoad({ connections: options.connections, durationMs: options.warmupMs, target });
  const result = await runLoad({ connections: options.connections, durationMs: options.durationMs, target });
  return summarize(result, undefined);
}

/**
 * Runs scenario 8 — the no-proxy denominator — once per distinct (scheme,
 * body size) the selected scenarios use, so a 10 MB run is never compared
 * against a 1 KB baseline. Always before the proxied runs: every ratio
 * reported later is against these.
 */
async function measureBaselines(selected, { upstreams, certs, options }) {
  const wanted = new Map();
  for (const scenario of selected) {
    const key = `${scenario.scheme}-${scenario.bodyBytes}`;
    if (!wanted.has(key)) wanted.set(key, scenario);
  }

  const baselines = new Map();
  const rows = [];
  for (const [key, scenario] of wanted) {
    const label = `${scenario.scheme}, ${formatBytes(scenario.bodyBytes)}`;
    process.stdout.write(`  running baseline (${label})...\n`);
    const metrics = await measureBaseline({ ...scenario, upstreams, certs, options });
    baselines.set(key, metrics);
    rows.push({ id: 8, key: `8-${key}`, name: `Direct, no proxy (${label})`, metrics });
  }
  return { baselines, rows };
}

async function measureScenario(scenario, { upstreams, options, tmpDir, upstreamCaPath }) {
  const rulesPath = scenario.rules ? writeRules(tmpDir, scenario.rules, { upstreamHttpsPort: upstreams.https.port }) : undefined;
  const detour = await startDetour({ rulesPath, dashboard: scenario.dashboard, upstreamCaPath });
  let dashboard;
  try {
    if (scenario.dashboard) dashboard = await connectDashboard(detour.dashboardPort);

    const target = {
      scheme: scenario.scheme,
      host: 'localhost',
      port: scenario.scheme === 'https' ? upstreams.https.port : upstreams.http.port,
      requestPath: `/bytes/${scenario.bodyBytes}`,
      proxyUrl: `http://127.0.0.1:${detour.proxyPort}`,
      // The client trusts Detour's MITM CA, exactly as a configured device does.
      ca: fs.readFileSync(detour.caCertPath, 'utf8'),
    };

    if (scenario.freshHosts) {
      const warmupHosts = Array.from({ length: 5 }, (_, i) => `warmup-${i}.bench.invalid`);
      await runFreshHosts({ connections: options.connections, hosts: warmupHosts, target: { ...target, port: 443 } });
      const hosts = Array.from({ length: scenario.freshHosts }, (_, i) => `host-${i}.bench.invalid`);
      const sampler = createProcessSampler(detour.pid);
      // Port 443 is what the CONNECT names; the route rule redirects the
      // upstream request itself to the local server, so nothing listens there.
      const result = await runFreshHosts({ connections: options.connections, hosts, target: { ...target, port: 443 } });
      return summarize(result, sampler.stop());
    }

    await runLoad({ connections: options.connections, durationMs: options.warmupMs, target });
    const sampler = createProcessSampler(detour.pid);
    const result = await runLoad({ connections: options.connections, durationMs: options.durationMs, target });
    return summarize(result, sampler.stop());
  } finally {
    dashboard?.close();
    await detour.stop();
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function renderTable(rows) {
  const headers = ['#', 'Scenario', 'req/s', 'p50 ms', 'p95 ms', 'p99 ms', 'RSS MB', 'CPU s', 'err', 'vs direct'];
  const body = rows.map((row) => [
    String(row.id),
    row.name,
    row.metrics.rps.toFixed(0),
    row.metrics.p50Ms.toFixed(2),
    row.metrics.p95Ms.toFixed(2),
    row.metrics.p99Ms.toFixed(2),
    row.metrics.peakRssMb ? row.metrics.peakRssMb.toFixed(0) : '-',
    row.metrics.cpuSeconds ? row.metrics.cpuSeconds.toFixed(1) : '-',
    String(row.metrics.errors),
    row.overhead ? `${row.overhead.p95Ratio.toFixed(2)}x p95 / ${row.overhead.rpsRatio.toFixed(2)}x rps` : '—',
  ]);

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => cells[column].length)),
  );
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const cells of body) console.log(line(cells));

  for (const row of rows) {
    if (row.metrics.errors > 0) {
      console.log(`\n  ! scenario ${row.id}: ${row.metrics.errors} failed request(s) — first: ${row.metrics.firstError}`);
    }
  }
}

function renderComparison(before, after) {
  const byId = new Map(after.rows.map((row) => [row.key, row]));
  console.log(`\nComparing ${before.startedAt} → ${after.startedAt}\n`);
  const headers = ['#', 'Scenario', 'req/s before', 'req/s after', 'Δ req/s', 'p95 before', 'p95 after', 'Δ p95'];
  const body = [];
  for (const previous of before.rows) {
    const current = byId.get(previous.key);
    if (!current) continue;
    const rpsDelta = (current.metrics.rps / previous.metrics.rps - 1) * 100;
    const p95Delta = (current.metrics.p95Ms / previous.metrics.p95Ms - 1) * 100;
    body.push([
      String(previous.id),
      previous.name,
      previous.metrics.rps.toFixed(0),
      current.metrics.rps.toFixed(0),
      `${rpsDelta >= 0 ? '+' : ''}${rpsDelta.toFixed(1)}%`,
      previous.metrics.p95Ms.toFixed(2),
      current.metrics.p95Ms.toFixed(2),
      `${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(1)}%`,
    ]);
  }
  const widths = headers.map((header, column) => Math.max(header.length, ...body.map((cells) => cells[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const cells of body) console.log(line(cells));
  console.log('\nΔ req/s: higher is better. Δ p95: lower is better.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the no-proxy baselines and then every selected scenario, always
 * shutting the upstreams down on the way out. The `finally` is the point: a
 * scenario that throws (a proxy that never became ready, a failed bind)
 * would otherwise leave two listening servers holding the event loop open,
 * and the whole run would hang instead of failing — in CI, sitting at "in
 * progress" until the job timeout with the actual error never printed.
 */
async function measureAll(selected, { upstreams, certs, options, tmpDir, upstreamCaPath }) {
  try {
    const { baselines, rows } = await measureBaselines(selected, { upstreams, certs, options });

    for (const scenario of selected) {
      process.stdout.write(`  running scenario ${scenario.id} (${scenario.name})...\n`);
      const metrics = await measureScenario(scenario, { upstreams, options, tmpDir, upstreamCaPath });
      const baseline = baselines.get(`${scenario.scheme}-${scenario.bodyBytes}`);
      rows.push({
        id: scenario.id,
        key: `${scenario.id}`,
        name: scenario.name,
        metrics,
        overhead: { p95Ratio: metrics.p95Ms / baseline.p95Ms, rpsRatio: metrics.rps / baseline.rps },
      });
    }
    return rows;
  } finally {
    await upstreams.http.close();
    await upstreams.https.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 38).join('\n'));
    return;
  }

  if (options.compare) {
    const [before, after] = options.compare.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    renderComparison(before, after);
    return;
  }

  const selected = SCENARIOS.filter((scenario) => options.scenarios.includes(scenario.id));
  if (selected.length === 0) throw new Error(`no scenarios matched: ${options.scenarios.join(',')}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-bench-'));
  const certs = generateUpstreamCert();
  const upstreamCaPath = path.join(tmpDir, 'upstream-ca.pem');
  fs.writeFileSync(upstreamCaPath, certs.caPem);

  const upstreams = { http: await startUpstream({ tls: false }), https: await startUpstream({ tls: true, certs }) };

  console.log(
    `Detour benchmark — ${selected.length} scenario(s), ${options.connections} connections, ` +
      `${options.durationMs / 1000}s each (+${options.warmupMs / 1000}s warmup)`,
  );
  console.log(`${os.type()} ${os.release()} · ${os.cpus()[0]?.model ?? 'unknown CPU'} · node ${process.version}\n`);

  const rows = await measureAll(selected, { upstreams, certs, options, tmpDir, upstreamCaPath });

  rows.sort((a, b) => a.id - b.id || a.key.localeCompare(b.key));
  console.log('');
  renderTable(rows);
  console.log('\n"vs direct" compares each scenario against the same request with no proxy in the middle.');

  const run = {
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    options: { connections: options.connections, durationMs: options.durationMs },
    rows,
  };
  if (options.json) {
    fs.writeFileSync(options.json, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`\nSaved to ${options.json} — diff two runs with: npm run bench -- --compare old.json new.json`);
  }

  if (options.gate) enforceGate(rows);
}

function formatBytes(bytes) {
  return bytes >= MB ? `${bytes / MB} MB` : `${bytes / KB} KB`;
}

/**
 * Fails the run when a gated scenario is slower than its ceiling allows,
 * relative to its own no-proxy baseline. Both numbers come from the same
 * machine minutes apart, which is what makes this usable on a CI runner
 * whose absolute speed varies from run to run.
 *
 * A failed request is a gate failure too, and that check has to come first:
 * an errored request contributes no latency sample, so a scenario where
 * *everything* failed has an empty sample set, a p95 of 0, and a ratio that
 * sails under any ceiling. The gate would then certify a run that measured
 * nothing — the one outcome worse than a slow one, because it reads as
 * proof that nothing regressed.
 */
function verdictFor(row) {
  if (row.metrics.requests === 0) return { ok: false, why: 'no successful requests' };
  if (row.metrics.errors > 0) {
    return { ok: false, why: `${row.metrics.errors} failed request(s): ${row.metrics.firstError}` };
  }
  const ceiling = GATE_MAX_P95_RATIO[row.id];
  const ratio = row.overhead.p95Ratio;
  return ratio > ceiling
    ? { ok: false, why: `p95 ${ratio.toFixed(1)}x baseline, over the ${ceiling}x ceiling` }
    : { ok: true, why: `p95 ${ratio.toFixed(1)}x baseline (ceiling ${ceiling}x)` };
}

function enforceGate(rows) {
  const gated = rows.filter((row) => row.overhead && GATE_MAX_P95_RATIO[row.id] !== undefined);
  const verdicts = gated.map((row) => ({ row, verdict: verdictFor(row) }));
  const failures = verdicts.filter(({ verdict }) => !verdict.ok);

  console.log('');
  for (const { row, verdict } of verdicts) {
    console.log(`  [${verdict.ok ? 'ok' : 'FAIL'}] scenario ${row.id}: ${verdict.why}`);
  }

  if (failures.length === 0) {
    console.log('Gate passed.');
    return;
  }
  console.error(
    `\nGate FAILED: ${failures.length} scenario(s). Latency is measured against a direct request on the same ` +
      'runner, so a ceiling breach is a real slowdown in the hot path rather than runner noise; a failed request ' +
      'means the scenario did not measure what it claims to.',
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
