# Detour — agent working rules

Shared by every coding agent working on this repository: Claude Code reads this
file through `CLAUDE.md`, Antigravity (`agy`) reads it directly.

## Model tiering: a light main model, a strong advisor

Day-to-day work (reading code, editing, running tests, writing PRs) runs on a
lighter, cheaper model. A stronger model is consulted as an **advisor** at the
points where judgment matters most:

1. **Before substantive work** — after orienting (finding files, reading the
   issue), before writing code or committing to an interpretation.
2. **When stuck** — the same error keeps recurring, or an approach isn't
   converging.
3. **Before declaring done** — once the change is committed, before reporting
   it as finished.

Treat the advice seriously. If it conflicts with evidence you have already
gathered (a test result, the code itself), say so and ask again rather than
silently switching.

How that maps onto each tool:

| | Main model | Advisor |
| --- | --- | --- |
| Claude Code | Sonnet (`.claude/settings.json` → `model`) | the built-in advisor tool on Fable (`advisorModel`); when it isn't available, the `advisor-opus` subagent (Opus) |
| agy | a Gemini Flash tier: `agy --model gemini-3.8-flash-medium` | a swarm member switched to Claude Opus (`swarm{action:"model", name:<member>, model:<the Claude Opus entry from swarm{action:"models"}>}`) — or switch the session itself with `/model` for the consultation and back afterwards |

agy has no advisor tool and its custom agents can't pin a model (a `model:`
frontmatter field is ignored), so the consultation there is explicit: hand the
advisor a short brief — the task, what you found, what you intend to do — since
it doesn't see your conversation the way Claude Code's advisor does.

## Working conventions

- **Commits and PR titles in English** (Conventional Commits:
  `feat(proxy): …`, `fix(dashboard): …`). release-please builds the changelog
  from them; prose in PR bodies may be Japanese.
- **Verify before committing**: `npm run verify:fast` (format, typecheck, lint,
  architecture checks, unit + web tests); `npm run verify` adds the CLI e2e
  suite and is what CI runs.
- **Review locally before pushing** non-trivial changes (Claude Code:
  `/code-review`), iterating until it converges, rather than iterating against
  bot reviews on the PR.
- **UI changes need a screenshot** in the PR (the dashboard under `web/`),
  proving the change works in a real browser.
- **Security-sensitive areas** (`src/infra/proxy/`, `src/infra/dashboard/`,
  `src/domain/auth/`): follow the `mitm-security-review` skill. Don't describe
  an unfixed vulnerability in a public issue or PR — see `SECURITY.md`.
- Project skills live in `.claude/skills/` (agy loads them through
  `.agents/skills.json`): `add-start-option`, `wire-format-change`,
  `detour-live-probe`, `mitm-security-review`, `architecture-inventory`,
  `create-pr`.
