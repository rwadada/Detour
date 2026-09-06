import { BookMarked } from 'lucide-react';
import { useRef, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button, Input, PillToggle, Select } from '@/shared/ui';

/**
 * Sentinel `<option>` value that opens the create form instead of applying
 * anything. Deliberately leading with `_` rather than a letter/digit — the
 * server rejects any profile name that doesn't (see `PROFILE_NAME_PATTERN`
 * in `src/infra/fs/ruleProfileStore.ts`), so this string can never collide
 * with a real one to begin with, not merely by convention.
 */
const NEW_PROFILE_OPTION = '__new_profile__';

type NewProfileSource = 'sample' | 'blank' | 'active';

/**
 * Header control for Rules Profiles (issue #19): switch which saved
 * ruleset is active, or create a new one. Mirrors `ThrottleControl`'s
 * popover pattern.
 *
 * Switching and creating both live in one `<select>` (design/PO review,
 * round 4) rather than a list of profiles each with its own "Apply"
 * button: picking an existing profile applies it immediately, and picking
 * the trailing "+ New profile…" option opens the create form below instead
 * of applying anything. The select's `value` is always the empty
 * placeholder, never the just-applied profile's name — there's no
 * server-side concept of "the currently active profile" to reflect (
 * `applyProfile` just overwrites rules.json's *content*; nothing records
 * which profile it came from), so this behaves as a one-shot action menu
 * rather than a control with persistent state, resetting to the
 * placeholder the instant React re-renders it after the change fires.
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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [source, setSource] = useState<NewProfileSource>('sample');
  // Set right after a successful apply/create/save, cleared after a couple
  // seconds — see its own note below. Not persisted state; a page reload or
  // a second pick before it clears just restarts (or skips) the timer.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // The select's `value` is always reset to the empty placeholder the
  // instant an option is picked (see the class doc comment above) —
  // deliberately, since there's no real "current profile" to hold it at.
  // But that alone left applying a profile looking like it silently did
  // nothing: nothing else in this popover (or the rest of the dashboard)
  // visibly changes just because rules.json's *content* changed underneath
  // it. This one-shot, self-clearing message is the only feedback that an
  // action actually went through.
  const confirm = (message: string) => {
    setConfirmation(message);
    setTimeout(() => setConfirmation((current) => (current === message ? null : current)), 2500);
  };

  // Resets the create form too, not just `open` — without this, dismissing
  // the popover mid-create (clicking outside, or the pill again) and later
  // reopening it would show whatever name/source was left sitting there,
  // stale, with `creating` still `true`. A `submitCreate` firing against
  // that stale state later would be an accidental save the user never
  // meant to make this time around.
  const closePopover = () => {
    setOpen(false);
    setCreating(false);
    setNewName('');
    setSource('sample');
    setConfirmation(null);
  };
  useDismissablePopover(open, containerRef, closePopover);

  // `rulesFile` can legitimately go from set to `null` while this form sits
  // open (the active rules file was unconfigured elsewhere) — its "Start
  // from" `<option value="active">` disappears from the `<select>` below
  // the moment that happens, but `source` itself doesn't follow along on
  // its own. Derived here (rather than synced back into `source` via a
  // `useEffect` — an unnecessary cascading-render setState React's own
  // guidance steers away from: https://react.dev/learn/you-might-not-need-an-effect)
  // so a controlled `<select>` never renders a `value` that doesn't match
  // any of its own `<option>`s, and `submitCreate` never acts on a stale
  // 'active' with nothing active to save. `source` itself still remembers
  // the user's actual pick, in case `rulesFile` reappears before they
  // change it.
  const effectiveSource: NewProfileSource = source === 'active' && !rulesFile ? 'sample' : source;

  // A dirty Rules editor draft ignores the next `rules` broadcast (see its
  // sync-from-server guard) so it can't be silently discarded by someone
  // else's change — but that means applying a profile here would otherwise
  // go through, the editor would keep showing the old draft as if nothing
  // happened, and a later "Save to rules.json" would clobber the
  // just-applied profile with that stale draft. Confirm and clear the
  // dirty flag first so the editor picks up the newly applied profile
  // instead.
  /** Returns whether the profile was actually applied — `false` means the dirty-draft confirm was declined, nothing happened. */
  const applyWithDirtyGuard = (name: string): boolean => {
    if (dirtyDraft && !window.confirm('Applying this profile will discard your unsaved rules.json edits. Continue?')) {
      return false;
    }
    setDirtyDraft(false);
    applyProfile(name);
    return true;
  };

  const handleSelectChange = (value: string) => {
    if (!value) return;
    if (value === NEW_PROFILE_OPTION) {
      setCreating(true);
      return;
    }
    // Picking an existing profile while the create form is still open (its
    // own selection didn't get here — this is the *other* branch of this
    // same select) is itself a "changed my mind" gesture; leaving the form
    // open afterward would let a later, unrelated "Save" click create/
    // overwrite a profile from whatever name/source was still sitting
    // there, stale. Only once the apply actually goes through, though —
    // declining the dirty-draft confirm above means nothing happened, and
    // discarding the in-progress create form anyway would be real data
    // loss for no reason. `cancelCreate` is a no-op if the form wasn't
    // open to begin with.
    if (applyWithDirtyGuard(value)) {
      cancelCreate();
      confirm(`Applied "${value}"`);
    }
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewName('');
    setSource('sample');
  };

  // `source: 'active'` captures the server's current rules.json (the last
  // thing actually "Save"d in the Rules editor) — not whatever's sitting
  // unsaved in the editor's draft. With a dirty draft open, what's on
  // screen and what this is about to snapshot as the new profile are two
  // different things; confirming makes that explicit instead of letting
  // someone assume it just captured their in-progress edits.
  //
  // Reads `effectiveSource`, not `source` — `effectiveSource` is never
  // `'active'` without `rulesFile` also being set (see its own doc
  // comment), so this never needs its own separate "is there actually
  // something active to save" check.
  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    if (effectiveSource === 'active') {
      if (
        dirtyDraft &&
        !window.confirm(
          'Your unsaved rules.json edits are not included — this saves what was last saved to rules.json. Continue?',
        )
      ) {
        return;
      }
      saveActiveAsProfile(name);
    } else {
      createProfile(name, effectiveSource);
    }
    cancelCreate();
    confirm(`Saved "${name}"`);
  };

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={profiles.length > 0}
        onClick={() => (open ? closePopover() : setOpen(true))}
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
          <p className="mb-2 text-xs text-[var(--muted)]">Switch to a saved profile, or create a new one.</p>

          <Select value="" onChange={(e) => handleSelectChange(e.target.value)} className="mb-2 w-full text-xs">
            <option value="" disabled>
              {profiles.length > 0 ? 'Switch profile…' : 'No saved profiles yet'}
            </option>
            {profiles.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name} ({profile.ruleCount})
              </option>
            ))}
            <option value={NEW_PROFILE_OPTION}>+ New profile…</option>
          </Select>

          {confirmation && <p className="mb-2 text-xs text-[var(--status-2xx)]">✓ {confirmation}</p>}

          {creating && (
            <div className="mb-1 rounded border border-[var(--border)] p-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="profile-name"
                autoFocus
                className="mb-1.5 h-7 w-full text-xs"
              />
              <Select
                value={effectiveSource}
                onChange={(e) => setSource(e.target.value as NewProfileSource)}
                className="mb-1.5 w-full text-xs"
              >
                <option value="sample">Start from: Sample rules</option>
                <option value="blank">Start from: Blank</option>
                {rulesFile && <option value="active">Start from: Currently active rules.json</option>}
              </Select>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={cancelCreate}>
                  Cancel
                </Button>
                <Button size="sm" className="flex-1" onClick={submitCreate} disabled={!newName.trim()}>
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
