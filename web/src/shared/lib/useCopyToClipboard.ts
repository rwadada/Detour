import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from './copyToClipboard';

/**
 * Tracks "was the text just copied" for a copy button's checkmark-flash UI —
 * shared by the sidebar's Proxy URL/LAN Access buttons and Copy-as-curl.
 * Takes a `getText` thunk rather than the text itself so building it (e.g.
 * Copy-as-curl's `buildCurlCommand`, which walks headers and decodes the
 * body) only happens on an actual click, not on every render this component
 * happens to do in between.
 *
 * Re-copying before the previous flash finished cancels that timer rather
 * than letting it fire on schedule and clear `copied` early: without this, a
 * click flood flickers the checkmark off mid-flash, up to 1.5s before the
 * *most recent* copy actually warrants it. Also clears the timer on unmount
 * — copying a URL and then, say, closing the sidebar's expanded view (which
 * unmounts these buttons) within 1.5s would otherwise still fire `setCopied`
 * against an unmounted component.
 */
export function useCopyToClipboard(getText: () => string) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = async () => {
    if (await copyToClipboard(getText())) {
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  return { copied, copy };
}
