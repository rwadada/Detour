/** What the dashboard server needs from the self-update machinery; injected so the server never touches the network or spawns processes itself. */
export interface UpdateService {
  readonly currentVersion: string;
  /** Whether this install can upgrade itself (Homebrew) *and* this instance can be relaunched by `detour update`. */
  readonly canSelfUpdate: boolean;
  /**
   * Latest released version, or null when it can't be determined right now. Cached — safe to call per connection.
   * `force` skips the cache for a user-requested re-check (still rate limited, so it can't be used to hammer GitHub).
   */
  getLatestVersion(options?: { force?: boolean }): Promise<string | null>;
  /**
   * Launches the detached updater (`detour update --yes`); resolves once it's spawned, not once the update has finished.
   * `onExit` fires only if the updater exits while this process is still alive — a successful update stops this
   * process first, so reaching it means nothing was restarted (formula lagging, brew error, already current…).
   */
  startUpdate(onExit: (exitCode: number | null) => void): Promise<void>;
}
