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

This is a solo-maintained, pre-1.0 project — there's no dedicated security
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
- **`--lan` / `lanAccess` widens that exposure to your local network,
  without authentication by default.** Only enable it on a network you
  trust, and set a dashboard password (`detour config --dashboard-password`)
  when you do.
- **The CA private key is a high-value secret.** It's the key behind a
  certificate you've asked your OS/browser to trust — anyone who reads it
  can mint valid-looking certificates for any domain, for as long as your
  system keeps trusting that CA. Treat `~/.detour/certs/keys/ca.private.key`
  like any other private key.
- **`rules.json` is not a sandboxed format.** A `script` action's hook runs
  with the same permissions as the `detour` process itself. Only load rules
  files you trust the origin of, the same way you'd treat any other local
  script.
- Certificate pinning inside a target app is a defense Detour (or any MITM
  proxy) cannot bypass from the network side — that's expected behavior, not
  a vulnerability in Detour.

If you're not sure whether something you found falls under this policy,
report it anyway — that's a judgment call better made together than alone.
