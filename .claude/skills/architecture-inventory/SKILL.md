---
name: architecture-inventory
description: Run periodic architecture inventory and code quality audits, comparing against de facto proxy tools, tracking metrics (complexity, duplication, line count), and structuring Tier 1/2/3 issues. Trigger when planning major rounds, auditing codebase structure, or when asked for "アーキテクチャ棚卸し" or "architecture inventory".
---

# Architecture Inventory & Codebase Audit

Periodic architecture audit procedure (used across Rounds #137, #157, and #215) to systematically discover, vet, and prioritize architectural gaps against de facto proxy tools (mitmproxy, Charles, Proxyman, HTTP Toolkit, Burp Suite).

## 1. Quantitative Codebase Metrics

Gather objective codebase numbers before raising issues:

### Codebase Size
```bash
echo "=== Backend Lines of Code ==="
find src -name '*.ts' ! -name '*.test.ts' | xargs wc -l | tail -n 1

echo "=== Frontend Lines of Code ==="
find web/src -name '*.ts' -o -name '*.tsx' | grep -v '\.test\.' | xargs wc -l | tail -n 1

echo "=== Test Lines of Code ==="
find src web/src -name '*.test.ts' -o -name '*.test.tsx' | xargs wc -l | tail -n 1
```

### Cognitive Complexity & Long Functions
Identify top god functions or files exceeding complexity limits:
```bash
npx eslint -f json src/ web/src/ 2>/dev/null | jq -r '
  .[] | select(.messages | length > 0) as $file |
  $file.messages[] |
  select(.ruleId == "sonarjs/cognitive-complexity" or .ruleId == "max-lines-per-function") |
  "\($file.filePath):\(.line) [\(.ruleId)] \(.message)"
'
```

### Code Duplication Check
Run `jscpd` to check overall duplication percentage (threshold is 6%):
```bash
npm run dup-check
```

### Architectural Boundaries & Dependency Rules
Check architectural layer enforcement:
```bash
npm run dep-cruise
npm run lint:fsd
```

## 2. De Facto Feature & Non-Functional Comparison

Compare Detour capabilities against industry de facto tools:
1. **mitmproxy / mitmweb**: CLI control, WebSocket proxy stability, Python/JS script hooks, replay.
2. **Proxyman**: Localhost pinning, mobile certificate automation (`detour setup`), breakpoints, map local.
3. **Charles Proxy**: Throttling profiles, rewrite rules, SSL pinning troubleshooting.
4. **HTTP Toolkit**: Clean zero-config intercept, self-target prevention, TLS fingerprinting.
5. **Burp Suite**: Scope management (Focus Hosts), repeater/compose, intruder-like sequences.

## 3. Vetting Findings (Counter-Argument Process)

Before creating issues, subject every finding to rigorous challenge:
1. **Is it truly a problem?** (Does it break user workflows, cause crashes, or create security hazards?)
2. **Is it already solved or covered by an existing issue?** Check open and closed issues:
   ```bash
   gh issue list --state all --search "<keyword>"
   ```
3. **Is it an intentional design trade-off?** (e.g., binding `0.0.0.0` for LAN access by design, or avoiding native C bindings).
4. **Reproduce on real process first**: Security and bug findings MUST be reproduced using `detour-live-probe` on the current `main` branch before filing.

## 4. Prioritization Tiers

Categorize verified issues by Tier:
- **Tier 1 (Critical)**: Security vulnerabilities (SSRF, auth bypass, memory/socket leak leading to freeze or data loss).
- **Tier 2 (High / Architecture)**: God functions requiring decomposition, architectural coupling, protocol duplication, key user-facing feature gaps (Repeater, Control API).
- **Tier 3 (Medium / Tooling)**: Build system improvements, developer tooling, skills, non-urgent performance optimizations.

## 5. Structuring the Issue

Organize with a tracking parent issue and sub-issues:
- List clear **Background**, **Evidence / Reproduction**, and **Acceptance Criteria**.
- Explicitly state what was considered and **dropped** ("第2周以降で落とした所見（issue化しない）") to document intentional design choices.
