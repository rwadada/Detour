@AGENTS.md

## Claude Code specifics

- `.claude/settings.json` runs sessions on **Sonnet** with **Fable** as the
  advisor (`model` / `advisorModel`). Override per session with
  `claude --model <model>` / `--advisor <model>`.
- Call the advisor tool at the three points in AGENTS.md: before substantive
  work, when stuck, and before declaring done (commit first, so the result is
  durable while it runs).
- **When no advisor tool is available** in a session (Fable can't be used, or
  the advisor is disabled), consult the `advisor-opus` subagent at those same
  points instead. It runs on Opus but doesn't see this conversation, so give it
  a brief: the task, what you found (files, test output), and what you intend
  to do.
- The Stop hook (`.claude/hooks/verify-stop.sh`) runs `npm run verify:fast`
  after a turn that edited `src/`, `web/`, `bin/` or `scripts/`; fix what it
  reports before finishing.
