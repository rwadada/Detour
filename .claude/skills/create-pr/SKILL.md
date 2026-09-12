---
name: create-pr
description: Prepare and open a pull request for this repo, filling out .github/PULL_REQUEST_TEMPLATE.md properly (why the change is needed, a summary of what changed, before/after screenshots for any UI change, and manual/automated verification results). Use when the user asks to open/create a PR, "PRを作って", or to push the current branch's work as a pull request.
---

# Creating a pull request

Follow this every time a PR is opened for this repo, whether via the `gh`
CLI or the GitHub MCP tools — don't skip straight to `create_pull_request`
with a thin body.

## 1. Sanity-check the branch

- Confirm `git status` is clean and you're not on `main`. If changes are
  uncommitted, commit them with a clear message first.
- Push the branch: `git push -u origin <branch-name>`.

## 2. Verify the change before writing the PR

Run the checks relevant to what changed (don't skip this to save time — a
red `npm run verify` after opening the PR is worse than a slower open):

- Small/non-behavioral change: at least `npm run format:check`,
  `npm run typecheck`, and `npm run lint` — CI's `verify` job runs
  `format:check` first, so a Markdown/whitespace-only issue that a
  typecheck/lint pass wouldn't catch can still fail CI on its own.
- Anything touching `src/`, `bin/`, or `web/src/`: `npm run verify` (runs
  format check, typecheck, lint, FSD/dep-cruise boundaries, dup-check,
  unit+coverage, dashboard tests, and CLI e2e — see `.github/workflows/pr.yml`).
- Note the actual commands you ran and their pass/fail result — this goes
  verbatim into the PR's Verification section, not a generic "tests pass".
- If you also exercised the change manually (e.g. `npm start -- start`,
  `npm run dev`, or a curl/dashboard check), record the concrete steps and
  what you observed.

## 3. Decide if this is a UI change

Check `git diff --stat origin/main...HEAD` (an explicit base ref — a bare
`git diff --stat` compares against the working tree/index, not the base
branch, and gives a wrong or empty answer). If it touches anything under
`web/src/` (the dashboard SPA) or otherwise changes rendered output, it's a
UI change and the PR **must** include before/after screenshots:

- Run `npm run dev:dashboard` (or `detour start`) to view the dashboard
  before and after the change, or check out the base branch, screenshot,
  then check out the PR branch and screenshot again. Save both as local
  files, e.g. `before.png` / `after.png`.
- Reference both local paths in the Screenshots section's before/after
  table in the PR body (e.g. `![before](./before.png)` /
  `![after](./after.png)`), then pass `--attach ./before.png --attach ./after.png`
  to `gh pr create`/`gh pr edit` (requires `gh` >= 2.99.0) — it uploads each
  file and rewrites the matching local-path reference in the body to the
  uploaded URL. `--attach` is repeatable (up to 50 files per command) and
  also works on `gh pr comment` for screenshots added after the PR is open.
  Add alt text with `--attach './before.png#Before: dashboard list view'`.
  When using the GitHub MCP tools instead of `gh` (no local `--attach`
  equivalent there), tell the user which local screenshot files to drag
  into the PR body/comment box themselves, since the API path can't upload
  images.
- If there's no UI change, delete the Screenshots section from the
  template rather than leaving it as boilerplate.

## 4. Fill out the template

Read `.github/PULL_REQUEST_TEMPLATE.md` and populate every required
section — never leave the HTML comments in place unanswered:

- **Why**: the motivating problem or linked issue — not just "adds X".
- **What**: a summary of the actual change and any notable approach/design
  decision.
- **Screenshots**: before/after, only when step 3 says this is a UI change.
- **Verification**: the exact commands from step 2 and their results, plus
  any manual repro steps and what you observed.

## 5. Open the PR

- Look for a PR template as described above (already handled here) and use
  it as the body's structure.
- Create the PR against `main` unless told otherwise.
- After creating it, start watching for CI failures and review comments so
  they get picked up promptly — GitHub's own Watch/notification settings,
  or whatever PR-activity tooling the current environment provides (this
  session's PR-subscription tool, `gh pr checks --watch`, etc.).

## 6. Report back

Tell the user the PR URL and a one-line summary of what verification was
run and its result. Don't claim verification you didn't actually run.
