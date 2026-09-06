/**
 * Writes `text` to the clipboard, returning whether it succeeded — never
 * throws. Prefers the async Clipboard API, but that's only available in a
 * secure context (HTTPS, or `localhost`); this dashboard is routinely opened
 * over plain `http://<LAN-address>` once `--lan` is on (issue #66's LAN
 * Access section is built specifically to hand out such URLs), where
 * `navigator.clipboard` is undefined — falls back to the older
 * `document.execCommand('copy')` (deprecated, but still works in an
 * insecure context) rather than throwing an unhandled rejection out of a
 * click handler. Also guards against `navigator`/`document` themselves
 * being undefined (a non-DOM runtime — this project's own vitest config has
 * no jsdom environment, see below) rather than just their properties, since
 * that's a `ReferenceError` no optional-chaining on a property access
 * catches. Not unit-tested — like `downloadTextFile.ts`, this is a DOM side
 * effect and this project's vitest config has no jsdom environment.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or the browser only pretends to support it here — fall through to the legacy path below.
    }
  }
  if (typeof document === 'undefined') return false;
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Off-screen rather than `display: none` — some browsers refuse to `select()` a non-rendered element.
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let succeeded: boolean;
  try {
    succeeded = document.execCommand('copy');
  } catch {
    succeeded = false;
  }
  document.body.removeChild(textarea);
  return succeeded;
}
