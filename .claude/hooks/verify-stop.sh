#!/bin/sh
# Runs on every Stop event (Claude finishing a response): typecheck + lint +
# unit tests, so implementation correctness is checked automatically instead
# of relying on someone remembering to run it. Exits 2 (Claude Code's
# "blocking error" signal for a Stop hook) with the failure output on
# stderr when anything fails, so Claude sees it and can act on it before
# truly stopping. Exits 0 silently on success.
cd "$CLAUDE_PROJECT_DIR" || exit 2
output=$(npm run verify 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  echo "$output" >&2
  exit 2
fi
exit 0
