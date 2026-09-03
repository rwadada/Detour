import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '@/shared/ui';
import { RulesEditorPanel } from './RulesEditorPanel';

/** Header control opening the Rules editor (issue #19) in a modal — see `RulesEditorPanel` for the form itself. */
export function RulesEditorButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Edit rules.json">
        <ListChecks className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Rules">
        <RulesEditorPanel />
      </Dialog>
    </>
  );
}
