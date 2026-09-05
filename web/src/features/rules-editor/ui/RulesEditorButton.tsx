import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { Button, Dialog } from '@/shared/ui';
import { RulesEditorPanel } from './RulesEditorPanel';

/** Header control opening the Rules editor (issue #19) in a modal — see `RulesEditorPanel` for the form itself. */
export function RulesEditorButton() {
  const [open, setOpen] = useState(false);
  const dirtyDraft = useRuleStore((s) => s.dirtyDraft);
  const setDirtyDraft = useRuleStore((s) => s.setDirtyDraft);

  // Escape, the backdrop, and the dialog's own "X" all funnel through this
  // one `onClose` — guarding it here (rather than in each trigger) confirms
  // discarding unsaved edits no matter how the close was triggered, instead
  // of silently dropping a half-written rule the moment focus slips outside
  // the modal.
  const requestClose = () => {
    if (dirtyDraft && !window.confirm('Discard unsaved changes to rules.json?')) return;
    // The confirm above only asks; it doesn't discard. `RulesEditorPanel`
    // unmounts on close and never runs its own `discard()`/`save()` (the
    // only two places that otherwise clear this flag), so without this the
    // store's `dirtyDraft` stays stuck true — the next open shows Save/
    // Discard enabled with nothing actually unsaved, and blocks the panel's
    // resync-from-server guard for no reason.
    setDirtyDraft(false);
    setOpen(false);
  };

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Edit rules.json">
        <ListChecks className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onClose={requestClose} title="Rules">
        <RulesEditorPanel />
      </Dialog>
    </>
  );
}
