import { type RefObject, useEffect } from 'react';

/**
 * Closes an open popover (FocusControl, ThrottleControl, …) on an outside
 * click or Escape. There's no dialog library in this project (see
 * web/package.json), so every header popover hand-rolls this the same way —
 * shared here rather than duplicated per component.
 */
export function useDismissablePopover(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, containerRef, onDismiss]);
}
