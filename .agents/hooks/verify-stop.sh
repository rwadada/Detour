#!/bin/sh
# agy Stop hook (see .agents/hooks.json): the counterpart of Claude Code's
# .claude/hooks/verify-stop.sh. When the working tree has uncommitted changes
# under src/, web/, bin/ or scripts/, runs `npm run verify:fast` before the
# agent finishes; if it fails, answers {"decision":"continue"} with the tail of
# the output so the agent fixes it instead of stopping. Doc- or config-only
# changes skip verify. It asks to continue at most once per turn
# (`continuationActive`), so a failure the agent can't fix doesn't loop.
#
# agy runs hooks with the working directory set to the folder holding
# hooks.json (.agents/), and reads the hook's decision from stdout.

input=$(cat)
continuation=$(printf '%s' "$input" | jq -r '.continuationActive // false' 2>/dev/null)
[ "$continuation" = "true" ] && exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

[ -n "$(git status --porcelain -- src web bin scripts 2>/dev/null)" ] || exit 0

output=$(npm run verify:fast 2>&1)
[ $? -eq 0 ] && exit 0

reason=$(printf 'npm run verify:fast failed — fix it before finishing:\n%s' "$(printf '%s' "$output" | tail -n 60)")
jq -n --arg reason "$reason" '{decision: "continue", reason: $reason}'
