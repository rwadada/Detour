---
name: mitm-security-review
description: Run Detour-specific MITM proxy security checklist and review when modifying proxy engine, dashboard server, authentication, or network handling. Trigger when reviewing security-sensitive changes under src/infra/proxy/, src/infra/dashboard/, or src/domain/auth/, or when asked for "セキュリティレビュー" or "security review" on Detour.
---

# Detour MITM Proxy Security Review Checklist

Use this checklist whenever changes touch `src/infra/proxy/**`, `src/infra/dashboard/**`, `src/domain/auth/**`, or CLI network options to ensure proxy safety invariants are maintained.

## Checklist

### 1. Self-Targeting & Loopback Reflection (SSRF Prevention)
- [ ] **Self-Target Detection**: Does the proxy reject requests attempting to loop back into its own listening ports (proxy port, dashboard port, control port)?
  - Ensure `src/infra/proxy/engine/selfTarget.ts` or related guards block requests targeting Detour's own services with `403 Forbidden` / `502 Bad Gateway` (tested by `selfTarget.test.ts` and `proxyEngine.selfTarget.test.ts`).
- [ ] **LAN-to-Localhost Trampolining (#205 / CVE-2025-23217 equivalent)**:
  - If a LAN client connects to Detour's proxy port, can it reach `http://localhost:<dashboard-port>` or internal services without authorization?
  - Verify access tokens or loopback filtering properly prevent unauthorized LAN access to loopback-only endpoints.

### 2. Host / Origin Validation & WebSocket Authentication
- [ ] **Dashboard WebSocket Origin Check**: Does the dashboard server validate incoming `Origin` headers before upgrading WebSocket connections? (Reject cross-site origins to prevent WS hijacking).
- [ ] **Access Token & Cookie Enforcement**:
  - Is the dashboard access token checked on initial connection?
  - Are cookies flagged with `HttpOnly`, `SameSite=Lax/Strict`, and `Secure` where appropriate?
- [ ] **Rate Limiting**: Are authentication attempts (dashboard password login) rate-limited against brute-force attacks (`src/infra/dashboard/dashboardServer.rateLimit.test.ts`)?

### 3. Credential & Header Leakage Prevention
- [ ] **Hop-by-Hop & Proxy Authentication Headers**:
  - Is `Proxy-Authorization` stripped before forwarding upstream?
  - Does `Proxy-Authorization` get redacted/excluded from `CapturedExchange` events broadcast over WebSocket or saved to SQLite history?
- [ ] **Sensitive Headers in Backlog & Dumps**:
  - Check that tokens or credentials are not serialized in plaintext into `backlogSnapshot.json` or HAR export files.

### 4. File Permissions & Path Traversal
- [ ] **CA Private Key Permissions**:
  - Is the generated CA private key (`detour-ca.key`) created with strict permissions (`0600` / `S_IRUSR | S_IWUSR`)?
  - Are config directory and files (`~/.detour/config.json`) properly restricted?
- [ ] **Rule Script Path Traversal**:
  - Are custom script rule paths verified using `safeRulePath`?
  - Are external script paths prohibited unless `--allow-external-script-paths` is explicitly provided?

### 5. Script Rule Execution Sandbox & Gate
- [ ] **Script Execution Gate (#161)**:
  - Are script rules disabled by default unless `--allow-scripts` is passed on the CLI?
  - If scripts fail to load or throw an exception, does the error get contained and reported without crashing the proxy server?

### 6. LAN Binding & Exposure Warning
- [ ] **Dashboard LAN Access Exposure**:
  - The proxy itself listens on all interfaces (`0.0.0.0`) by design so external/mobile devices can route through it. `--lan` controls whether the *dashboard* (and its web interface) is exposed to the local network or restricted to localhost.
  - When `--lan` is specified, verify the CLI banner and logs clearly warn that the dashboard is bound to `0.0.0.0` and accessible over the LAN.
  - Without `--lan`, verify the dashboard strictly binds to `127.0.0.1`.
