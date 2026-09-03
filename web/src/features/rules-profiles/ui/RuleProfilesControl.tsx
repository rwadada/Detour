import { BookMarked } from 'lucide-react';
import { useRef, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button, Input, PillToggle, Select } from '@/shared/ui';

/**
 * Header control for Rules Profiles (issue #19): switch which saved
 * ruleset is active, save the current rules as a new profile, or create a
 * blank/starter one. Mirrors `ThrottleControl`'s popover pattern.
 */
export function RuleProfilesControl() {
  const profiles = useRuleStore((s) => s.profiles);
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const applyProfile = useRuleStore((s) => s.applyProfile);
  const saveActiveAsProfile = useRuleStore((s) => s.saveActiveAsProfile);
  const createProfile = useRuleStore((s) => s.createProfile);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [template, setTemplate] = useState<'blank' | 'sample'>('sample');
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, containerRef, () => setOpen(false));

  const createAndClear = () => {
    if (!newName.trim()) return;
    createProfile(newName.trim(), template);
    setNewName('');
  };

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={profiles.length > 0}
        onClick={() => setOpen((v) => !v)}
        icon={<BookMarked className="h-3 w-3" />}
        title="Rule profiles — saved rulesets you can switch between"
      >
        Profiles{profiles.length > 0 ? ` (${profiles.length})` : ''}
      </PillToggle>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">Switch, save, or create a saved ruleset.</p>

          {profiles.length === 0 ? (
            <p className="mb-2 text-xs text-[var(--muted)]">No saved profiles yet.</p>
          ) : (
            <ul className="mb-2 max-h-40 overflow-auto">
              {profiles.map((profile) => (
                <li key={profile.name} className="flex items-center justify-between gap-2 py-1 text-xs">
                  <span className="truncate">
                    {profile.name} <span className="text-[var(--muted)]">({profile.ruleCount})</span>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => applyProfile(profile.name)}>
                    Apply
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="mb-2 flex gap-1">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="profile-name"
              className="h-7 flex-1 text-xs"
            />
            <Select
              value={template}
              onChange={(e) => setTemplate(e.target.value as 'blank' | 'sample')}
              className="w-24"
            >
              <option value="sample">Sample</option>
              <option value="blank">Blank</option>
            </Select>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="flex-1" onClick={createAndClear} disabled={!newName.trim()}>
              New from template
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                if (!newName.trim()) return;
                saveActiveAsProfile(newName.trim());
                setNewName('');
              }}
              disabled={!newName.trim() || !rulesFile}
              title={!rulesFile ? 'No active rules to save' : undefined}
            >
              Save active as…
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
