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
  const dirtyDraft = useRuleStore((s) => s.dirtyDraft);
  const setDirtyDraft = useRuleStore((s) => s.setDirtyDraft);
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

  // A dirty Rules editor draft ignores the next `rules` broadcast (see its
  // sync-from-server guard) so it can't be silently discarded by someone
  // else's change — but that means applying a profile here would otherwise
  // go through, the editor would keep showing the old draft as if nothing
  // happened, and a later "Save to rules.json" would clobber the
  // just-applied profile with that stale draft. Confirm and clear the
  // dirty flag first so the editor picks up the newly applied profile
  // instead.
  const applyWithDirtyGuard = (name: string) => {
    if (dirtyDraft && !window.confirm('Applying this profile will discard your unsaved rules.json edits. Continue?')) {
      return;
    }
    setDirtyDraft(false);
    applyProfile(name);
  };

  // `saveActiveAsProfile` captures the server's current rules.json (the
  // last thing actually "Save"d in the Rules editor) — not whatever's sitting
  // unsaved in the editor's draft. With a dirty draft open, what's on screen
  // and what this button is about to snapshot as the new profile are two
  // different things; confirming makes that explicit instead of letting
  // someone assume it just captured their in-progress edits.
  const saveActiveWithDirtyGuard = () => {
    if (!newName.trim()) return;
    if (
      dirtyDraft &&
      !window.confirm(
        'Your unsaved rules.json edits are not included — this saves what was last saved to rules.json. Continue?',
      )
    ) {
      return;
    }
    saveActiveAsProfile(newName.trim());
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
        // `left-0`, not `right-0` (which `ThrottleControl`'s popover — living
        // in the top toolbar, with room to spare on both sides — uses):
        // this control sits in the narrow sidebar near the left edge of the
        // viewport, so anchoring the popover's *right* edge to the button
        // pushed most of its `w-72` off the left side of the screen entirely.
        <div className="absolute left-0 top-full z-10 mt-2 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
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
                  <Button variant="outline" size="sm" onClick={() => applyWithDirtyGuard(profile.name)}>
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
              onClick={saveActiveWithDirtyGuard}
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
