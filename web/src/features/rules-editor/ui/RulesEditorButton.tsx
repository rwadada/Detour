import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { Button, Dialog } from '@/shared/ui';
import { RulesEditorPanel } from './RulesEditorPanel';

/** Header control opening the Rules editor (issue #19) in a modal — see `RulesEditorPanel` for the form itself. */
export function RulesEditorButton() {
  const [open, setOpen] = useState(false);
  const dirtyDraft = useRuleStore((s) => s.dirtyDraft);

  // Escape, the backdrop, and the dialog's own "X" all funnel through this
  // one `onClose` — guarding it here (rather than in each trigger) confirms
  // discarding unsaved edits no matter how the close was triggered, instead
  // of silently dropping a half-written rule the moment focus slips outside
  // the modal.
  const requestClose = () => {
    if (dirtyDraft && !window.confirm('Discard unsaved changes to rules.json?')) return;
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
