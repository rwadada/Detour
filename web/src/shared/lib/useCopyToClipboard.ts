import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from './copyToClipboard';

/**
 * Tracks "was `text` just copied" for a copy button's checkmark-flash UI —
 * shared by the sidebar's Proxy URL/LAN Access buttons and Copy-as-curl.
 * Re-copying before the previous flash finished cancels that timer rather
 * than letting it fire on schedule and clear `copied` early: without this, a
 * click flood flickers the checkmark off mid-flash, up to 1.5s before the
 * *most recent* copy actually warrants it. Also clears the timer on unmount
 * — copying a URL and then, say, closing the sidebar's expanded view (which
 * unmounts these buttons) within 1.5s would otherwise still fire `setCopied`
 * against an unmounted component.
 */
export function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  return { copied, copy };
}
