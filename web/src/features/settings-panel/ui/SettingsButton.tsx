import { Settings } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '@/shared/ui';
import { SettingsPanel } from './SettingsPanel';

/** Sidebar control opening the consolidated Settings panel (issue #24) in a modal — see `SettingsPanel` for the form itself. */
export function SettingsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Settings">
        <Settings className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Settings" className="max-w-md">
        <SettingsPanel />
      </Dialog>
    </>
  );
}
