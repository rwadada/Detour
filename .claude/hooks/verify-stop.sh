#!/bin/sh
# Runs on every Stop event (Claude finishing a response). Only runs
# typecheck + lint + tests (npm run verify) when this turn actually touched
# an implementation file under src/, web/, bin/, or scripts/ — recorded by
# the PostToolUse hook (record-edited-file.sh) into a per-session state
# file. Doc-only, config-only, or no-edit turns skip verify entirely.
# Exits 2 (Claude Code's "blocking error" signal for a Stop hook) with the
# failure output on stderr when verify fails, so Claude sees it and can act
# on it before truly stopping. Exits 0 silently otherwise.
cd "$CLAUDE_PROJECT_DIR" || exit 2

state_dir="$CLAUDE_PROJECT_DIR/.claude/hooks/.stop-state"
# Best-effort tidy of stale per-session state files from old sessions.
find "$state_dir" -type f -mtime +1 -delete 2>/dev/null

session_id=$(jq -r '.session_id // empty' 2>/dev/null)
[ -n "$session_id" ] || exit 0
# Same charset guard as record-edited-file.sh: session_id feeds a file path.
case "$session_id" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac
state_file="$state_dir/edited-files-$session_id.txt"
[ -f "$state_file" ] || exit 0

if ! grep -Eq '(^|/)(src|web|bin|scripts)/' "$state_file" 2>/dev/null; then
  # Nothing implementation-relevant recorded this turn. Clear it anyway so a
  # long run of doc/config-only turns doesn't let the file grow unbounded.
  : > "$state_file" 2>/dev/null
  exit 0
fi

output=$(npm run verify 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  echo "$output" >&2
  exit 2
fi

# Verify passed: this turn's implementation changes are covered. Reset the
# state file so an unrelated later turn with no new edits doesn't re-verify.
: > "$state_file" 2>/dev/null
exit 0
