import { ListPlus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import type { CapturedExchange } from '@/shared/api';
import { Button } from '@/shared/ui';
import { generateRuleFromExchange, type GeneratableActionType } from '../model/generateRule';

const ACTION_LABELS: Record<GeneratableActionType, string> = {
  mock: 'Mock — freeze this response',
  route: 'Route — redirect elsewhere',
  rewrite: 'Rewrite — modify headers/body',
  breakpoint: 'Breakpoint — pause and edit',
};
const ACTION_TYPES = Object.keys(ACTION_LABELS) as GeneratableActionType[];

/**
 * Generates a new, unsaved rule matching this exchange's exact method and
 * URL, then queues it into the Rules editor (`RuleState.pendingNewRule`) —
 * `RulesEditorButton` opens on its own the moment that happens, with the new
 * rule already selected for review. Shown next to Copy as cURL/Replay in
 * `InspectorPanel`, its only consumer — co-located here rather than as its
 * own `features/` slice (steiger's FSD lint flagged a single-consumer
 * feature slice as insignificant enough to just merge in).
 *
 * Disabled with no rules file configured for this session (mirrors
 * `RuleProfilesControl`'s own "Save active as…" guard) — there'd be nowhere
 * to save the result, and `RulesEditorPanel` itself has no rules.json to
 * show the queued rule inside of either.
 */
export function CreateRuleButton({ exchange }: { exchange: CapturedExchange }) {
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const queueNewRule = useRuleStore((s) => s.queueNewRule);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, containerRef, () => setOpen(false));

  const pick = (type: GeneratableActionType) => {
    queueNewRule(generateRuleFromExchange(exchange, type));
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        disabled={!rulesFile}
        title={rulesFile ? 'Create a rule from this exchange' : 'No rules file configured for this session'}
      >
        <ListPlus className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-60 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow-lg">
          <p className="mb-1 px-1.5 text-xs text-[var(--muted)]">Create a rule matching this request…</p>
          {ACTION_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => pick(type)}
              className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--row-hover)]"
            >
              {ACTION_LABELS[type]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
