/** Shared by every per-target module (android/ios/mac/linux) — `CommandRunError` (from a failed `CommandRunner.run`) already carries a plain `.message` like any other `Error`, so there's nothing target-specific to unwrap here. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
