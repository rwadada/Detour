#!/bin/sh
# Runs on PostToolUse for Write|Edit. Appends the touched file's path to a
# per-session state file so the Stop hook (verify-stop.sh) can tell whether
# this turn actually changed an implementation file before paying for a full
# `npm run verify`. Cheap and silent: never blocks, never prints.
input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
file=$(printf '%s' "$input" | jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)
[ -n "$session_id" ] && [ -n "$file" ] || exit 0
# session_id ends up as part of a file path below; reject anything but the
# safe charset so a crafted/unexpected value can't escape .stop-state/ or
# collide with an unintended path (e.g. "../", "/").
case "$session_id" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac

state_dir="$CLAUDE_PROJECT_DIR/.claude/hooks/.stop-state"
mkdir -p "$state_dir" 2>/dev/null || exit 0
printf '%s\n' "$file" >> "$state_dir/edited-files-$session_id.txt"
exit 0
