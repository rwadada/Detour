/**
 * Watches a file for changes. Implemented against `fs.watch` by
 * `infra/fs/rulesFileSource.ts`'s `fsFileWatcher` — kept as an interface
 * here so `RuleEngine` (a UseCase) never touches `fs` directly.
 */
export interface FileWatcher {
  /**
   * Starts watching `filePath`; calls `onChange` on each modification and
   * `onError` if the watch itself fails. Returns a function that stops
   * watching.
   */
  watch(filePath: string, onChange: () => void, onError: (message: string) => void): () => void;
}
