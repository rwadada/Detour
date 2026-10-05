# Security Policy

Detour is a MITM (man-in-the-middle) HTTP debugging proxy: it decrypts HTTPS
traffic through a locally-generated CA certificate, can bind its proxy and
dashboard to the network, and its dashboard can view decrypted traffic and
edit rules that affect live requests. Given that, security reports are taken
seriously and handled privately before any public disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/rwadada/Detour/security) of
   this repository.
2. Click **"Report a vulnerability"**.

This opens a private advisory visible only to the maintainer and you, so the
issue can be discussed and fixed before it's public. It requires a GitHub
account.

Please include, where relevant:

- The affected version (`detour --version` or the `package.json` version)
- Steps to reproduce, or a minimal proof of concept
- What you observed vs. what you expected
- The impact you believe this has (what an attacker gains, and what access
  they'd need to exploit it)

## What to expect

This is a solo-maintained project — there's no dedicated security
team and no guaranteed SLA. That said, reports are read promptly, and a fix
or mitigation is prioritized over other work once a report is confirmed.
Credit is happily given in the fix's release notes, unless you'd rather stay
anonymous.

## Scope and threat model

Detour is a **local development tool**, not a hosted service — the proxy and
dashboard run on your own machine. Worth knowing up front:

- **Localhost is the assumed trust boundary for the dashboard**, not a
  security boundary on its own. The dashboard exposes decrypted traffic and
  a rule engine that can execute arbitrary JavaScript (`script` rules) and
  redirect traffic (`route` rules) — treat anything that can reach it as
  having meaningful access to what's flowing through the proxy.
- **The proxy itself is reachable from your local network unconditionally**
  — `--lan`/`lanAccess` doesn't gate it, and never has; a proxy nothing else
  on the network can reach isn't very useful. `--lan`/`lanAccess` only
  widens the **dashboard's** exposure the same way, from localhost-only to
  your whole LAN, with no authentication by default. Only enable it on a
  network you trust, and set a dashboard password
  (`detour config --dashboard-password`) when you do.
- **The CA private key is a high-value secret.** It's the key behind a
  certificate you've asked your OS/browser to trust — anyone who reads it
  can mint valid-looking certificates for any domain, for as long as your
  system keeps trusting that CA. Treat `~/.detour/certs/keys/ca.private.key`
  like any other private key.
- **`rules.json` is not a sandboxed format.** A `script` action's hook runs
  with the same permissions as the `detour` process itself — up to and
  including its CA private key. Only load rules files you trust the origin
  of, the same way you'd treat any other local script. `script.path` and
  `mock.bodyFile` are restricted to the directory rules.json lives in by
  default (an absolute path or `../` traversal is rejected) —
  `detour start --allow-external-script-paths` opts back into unrestricted
  paths for both, if you deliberately want that.
- **`script` rules don't run at all unless you opt in.** `detour start
  --allow-scripts` is required before a `script` rule's `beforeRequest`/
  `beforeResponse` hooks actually execute — without it, a matching `script`
  rule is skipped (with a warning), not run. This exists because the
  dashboard can reach an *existing* `script` rule over the network with
  nothing but a dashboard password (or, if none is set, nothing at all)
  standing between a remote client and code execution with the CA private
  key's permissions. Every dashboard action that can change what's active —
  `setRules` and `applyRuleProfile` alike — also refuses to add a brand-new
  `script` rule or change an existing one's `path`, regardless of
  `--allow-scripts`; that half of the chain (a rules.json file, or a saved
  profile, you already trust enough to run) is the only thing
  `--allow-scripts` is meant to gate. A `script` hook that never resolves
  also no longer hangs its exchange forever: `--script-timeout-ms` (default
  5000) forwards the exchange untouched and logs an error once it's
  exceeded.
- Certificate pinning inside a target app is a defense Detour (or any MITM
  proxy) cannot bypass from the network side — that's expected behavior, not
  a vulnerability in Detour.

## Supply chain

Detour installs a root CA and updates itself, so how it is built and
released matters as much as its own code:

- **Release tarballs carry a SLSA build-provenance attestation** (GitHub
  Artifact Attestations). Verify one with
  `gh attestation verify detour-<version>.tar.gz --repo rwadada/Detour`.
  The sha256 in the release notes remains the quick integrity check;
  `detour update` itself does not run the attestation check yet.
- **GitHub Actions are pinned to commit SHAs**, and Dependabot keeps both
  those pins and the npm dependencies current (weekly).
- **CodeQL** (`javascript-typescript`) runs on every pull request, on
  pushes to `main`, and weekly.
- **`node-forge` decision (kept, revisit when a fix lands).** It generates
  the CA/leaf keys and signs the certificates, and parses the CA PEM for
  `detour cert`. Detour never uses it to *verify* signatures. The one open
  advisory against it
  ([GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv),
  RSA PKCS#1 v1.5 signature *verification*, no patched release) is therefore
  not reachable through Detour. Replacing it (a `node:crypto` key pair plus
  an X.509 builder such as `@peculiar/x509`) is a candidate if a
  generation/signing issue is ever found, but swapping the code path that
  mints the root CA purely on a hunch carries more risk than it removes.

If you're not sure whether something you found falls under this policy,
report it anyway — that's a judgment call better made together than alone.
