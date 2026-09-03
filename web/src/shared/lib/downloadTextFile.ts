/** Triggers a browser download of `content` as `fileName` — a thin DOM side effect, not unit-tested (no jsdom in this project's vitest config; see `vitest.config.ts`). Shared by `features/log-export` and `features/session`, both of which need to hand the user a JSON file. */
export function downloadTextFile(fileName: string, content: string, mimeType = 'application/json'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
