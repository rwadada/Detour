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

- Small/non-behavioral change: at least `npm run typecheck` and
  `npm run lint`.
- Anything touching `src/`, `bin/`, or `web/src/`: `npm run verify` (runs
  format check, typecheck, lint, FSD/dep-cruise boundaries, dup-check,
  unit+coverage, dashboard tests, and CLI e2e — see `.github/workflows/pr.yml`).
- Note the actual commands you ran and their pass/fail result — this goes
  verbatim into the PR's Verification section, not a generic "tests pass".
- If you also exercised the change manually (e.g. via the `run` skill,
  `detour start`, or a curl/dashboard check), record the concrete steps and
  what you observed.

## 3. Decide if this is a UI change

Check `git diff --stat` against the base branch. If it touches anything
under `web/src/` (the dashboard SPA) or otherwise changes rendered output,
it's a UI change and the PR **must** include before/after screenshots:

- Use the `run` skill (or `npm run dev:dashboard` / `detour start`) to view
  the dashboard before and after the change, or check out the base branch,
  screenshot, then check out the PR branch and screenshot again.
- Attach both images in the PR body's Screenshots section as a before/after
  pair, not just an "after" shot.
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
- After creating it, subscribe to its activity (`subscribe_pr_activity` /
  `gh pr view --json` + watching, depending on environment) so CI failures
  and review comments get picked up, per this session's PR-babysitting
  rules.

## 6. Report back

Tell the user the PR URL and a one-line summary of what verification was
run and its result. Don't claim verification you didn't actually run.
