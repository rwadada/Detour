import { BookMarked } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { cn } from '@/shared/lib/utils';
import { Button, Input, PillToggle, Select } from '@/shared/ui';

/**
 * What `handleSelectChange`/`submitCreate` are waiting to confirm after
 * dispatching an `applyProfile`/`saveActiveAsProfile`/`createProfile` — these
 * are all fire-and-forget over WS (no per-request ack), so the *label* to
 * show on success is decided up front, but showing it at all waits for the
 * specific state change that action should actually produce (see the
 * `pending`-resolving effect below) rather than firing the instant it's
 * sent, which could show "✓ Applied" even for a request the server went on
 * to reject.
 */
type PendingConfirmation =
  | { kind: 'activeProfile'; name: string; label: string }
  | { kind: 'profileCreated'; name: string; label: string };

/** How long a `pending` confirmation waits for its expected state change (or an error) before giving up silently — WS delivery on a live connection is effectively instant, so this is just a bailout for the unusual case (a dropped connection, say) where neither ever arrives. */
const PENDING_CONFIRMATION_TIMEOUT_MS = 5000;

/**
 * Sentinel `<option>` value that opens the create form instead of applying
 * anything. Deliberately leading with `_` rather than a letter/digit — the
 * server rejects any profile name that doesn't (see `PROFILE_NAME_PATTERN`
 * in `src/infra/fs/ruleProfileStore.ts`), so this string can never collide
 * with a real one to begin with, not merely by convention.
 */
const NEW_PROFILE_OPTION = '__new_profile__';

type NewProfileSource = 'sample' | 'blank' | 'active';

/** The pill's own label — active profile name, else a saved-profile count, else the bare feature name. Pulled out of the JSX to avoid nesting ternaries there. */
function pillLabel(activeProfile: string | undefined, savedCount: number): string {
  if (activeProfile) return `Profile: ${activeProfile}`;
  if (savedCount > 0) return `Profiles: ${savedCount} saved`;
  return 'Profiles';
}

/**
 * Header control for Rules Profiles (issue #19): switch which saved
 * ruleset is active, or create a new one. Mirrors `ThrottleControl`'s
 * popover pattern.
 *
 * Switching and creating both live in one `<select>` (design/PO review,
 * round 4) rather than a list of profiles each with its own "Apply"
 * button: picking an existing profile applies it immediately, and picking
 * the trailing "+ New profile…" option opens the create form below instead
 * of applying anything. The select's own `value` is always the empty
 * placeholder, never the just-applied profile's name, and resets to it the
 * instant React re-renders after the change fires — it's a one-shot action
 * menu, not a control with state of its own to hold.
 *
 * "Which profile is currently active" (design/PO review, round 5 — reported
 * as unclear that switching had worked at all) is instead read off
 * `rulesFile.$activeProfile`, which the *server* now tracks by writing that
 * field alongside rules.json's content whenever `applyProfile`/
 * `saveActiveAsProfile` succeed — see `RulesFile.$activeProfile`'s doc
 * comment for exactly when it's set vs. cleared.
 */
export function RuleProfilesControl() {
  const profiles = useRuleStore((s) => s.profiles);
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const applyProfile = useRuleStore((s) => s.applyProfile);
  const saveActiveAsProfile = useRuleStore((s) => s.saveActiveAsProfile);
  const createProfile = useRuleStore((s) => s.createProfile);
  const dirtyDraft = useRuleStore((s) => s.dirtyDraft);
  const setDirtyDraft = useRuleStore((s) => s.setDirtyDraft);
  const lastError = useRuleStore((s) => s.lastError);
  const dismissError = useRuleStore((s) => s.dismissError);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [source, setSource] = useState<NewProfileSource>('sample');
  // What an in-flight apply/save/create is waiting to confirm — see
  // `PendingConfirmation`'s own doc comment.
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  // Set once `pending` actually resolves — a genuine success (matching
  // `pending`'s own label) or the error the server rejected it with —
  // cleared after a couple seconds. Not persisted state; a page reload just
  // loses it.
  const [banner, setBanner] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  // The pending auto-clear timer for `banner`, if any — tracked so a second
  // one within the same couple seconds cancels the first instead of leaving
  // it running alongside the new one.
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const showBanner = (text: string, kind: 'success' | 'error') => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), 2500);
  };

  // Clears a still-pending auto-clear timer on unmount — this component
  // isn't currently ever conditionally unmounted while its popover could be
  // open, but nothing prevents that changing later, and a timer outliving
  // its component calling `setBanner` on the way out is exactly the kind of
  // mistake that's cheap to rule out now and easy to forget to add later.
  useEffect(() => {
    return () => {
      if (bannerTimer.current) clearTimeout(bannerTimer.current);
    };
  }, []);

  // Resolves `pending` against whichever of `rulesFile`/`lastError` actually
  // changes first — these WS commands are fire-and-forget with no
  // per-request ack, so the only way to tell a genuine success from a
  // server-side rejection (a `RULE_PROFILE_ERROR` bumping `lastError`,
  // e.g. the profile was deleted after the `<select>` was rendered but
  // before this was picked) is to wait for the specific state change the
  // action should actually produce, rather than assuming success the
  // instant it was sent.
  useEffect(() => {
    if (!pending) return;
    // Genuinely the "subscribe to an external store, setState in response"
    // case React's own effect docs call out as legitimate — `lastError`/
    // `rulesFile`/`profiles` all change asynchronously from a WS message
    // arriving, not from any event this component itself handles, so
    // there's no synchronous event-handler callback to move this into
    // instead.
    if (lastError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      showBanner(lastError, 'error');
      dismissError();
      setPending(null);
      return;
    }
    const resolved =
      pending.kind === 'activeProfile'
        ? rulesFile?.$activeProfile === pending.name
        : profiles.some((profile) => profile.name === pending.name);
    if (resolved) {
      showBanner(pending.label, 'success');
      setPending(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showBanner/dismissError are stable-enough closures over refs/store actions, not reactive values this effect should re-run for
  }, [pending, lastError, rulesFile, profiles]);

  // Bails out of a `pending` confirmation that never resolved either way —
  // see `PENDING_CONFIRMATION_TIMEOUT_MS`'s own doc comment.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), PENDING_CONFIRMATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

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
    // Also drops any still-unresolved `pending` confirmation — without this,
    // a WS response arriving after the popover's already closed would still
    // resolve it (the effect above doesn't know or care whether `open` is
    // true), popping a stale "✓ Applied" up the *next* time the popover
    // opens instead of never showing it at all, like closing should mean.
    setPending(null);
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner(null);
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

  // See `RulesFile.$activeProfile`'s doc comment — `undefined` means the
  // active rules.json isn't (or isn't known to still be) any saved
  // profile's, not that the feature is broken.
  const activeProfile = rulesFile?.$activeProfile;
  const enabledCount = rulesFile?.rules.filter((rule) => rule.enabled !== false).length ?? 0;

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
      setPending({ kind: 'activeProfile', name: value, label: `Applied "${value}"` });
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
      setPending({ kind: 'activeProfile', name, label: `Saved "${name}"` });
    } else {
      createProfile(name, effectiveSource);
      setPending({ kind: 'profileCreated', name, label: `Saved "${name}"` });
    }
    cancelCreate();
  };

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={!!activeProfile}
        onClick={() => (open ? closePopover() : setOpen(true))}
        icon={<BookMarked className="h-3 w-3" />}
        title={
          activeProfile
            ? `Rule profiles — "${activeProfile}" is currently active`
            : 'Rule profiles — saved rulesets you can switch between'
        }
      >
        {/* Spelled out ("2 saved"), not a bare "(2)" — this button's count
            is one of several similar "(N)" pills across the toolbar/sidebar
            (Focus, Block Hosts, ...), each counting a different thing implied
            only by that pill's own label; a bare number here was reported as
            unclear on its own. Left as-is on the other pills (design/PO
            review): fixing this in one place doesn't obligate matching it
            everywhere in the same pass. Showing the active profile's name
            here (rather than just a count) once one exists directly answers
            "which profile is applied right now" without opening the popover
            at all — the other half of that same round's report. */}
        {pillLabel(activeProfile, profiles.length)}
      </PillToggle>
      {open && (
        // `left-0`, not `right-0` (which `ThrottleControl`'s popover — living
        // in the top toolbar, with room to spare on both sides — uses):
        // this control sits in the narrow sidebar near the left edge of the
        // viewport, so anchoring the popover's *right* edge to the button
        // pushed most of its `w-72` off the left side of the screen entirely.
        <div className="absolute left-0 top-full z-10 mt-2 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">Switch to a saved profile, or create a new one.</p>

          {rulesFile && (
            <p className="mb-2 text-xs text-[var(--muted)]">
              Active:{' '}
              {activeProfile ? (
                <span className="font-medium text-[var(--foreground)]">{activeProfile}</span>
              ) : (
                <span className="italic">unnamed (edited since a profile was last applied)</span>
              )}{' '}
              — {enabledCount} of {rulesFile.rules.length} {rulesFile.rules.length === 1 ? 'rule' : 'rules'} enabled
            </p>
          )}

          <Select value="" onChange={(e) => handleSelectChange(e.target.value)} className="mb-2 w-full text-xs">
            <option value="" disabled>
              {profiles.length > 0 ? 'Switch profile…' : 'No saved profiles yet'}
            </option>
            {profiles.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name} — {profile.ruleCount} {profile.ruleCount === 1 ? 'rule' : 'rules'}
              </option>
            ))}
            <option value={NEW_PROFILE_OPTION}>+ New profile…</option>
          </Select>

          {banner && (
            <p
              className={cn(
                'mb-2 text-xs',
                banner.kind === 'success' ? 'text-[var(--status-2xx)]' : 'text-[var(--status-5xx)]',
              )}
            >
              {banner.kind === 'success' ? '✓' : '✗'} {banner.text}
            </p>
          )}

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
