import {
  PRESETS,
  presetFor,
  ThrottleFields,
  useBlockHostsStore,
  useFocusStore,
  useInterceptStore,
  useThrottleStore,
  type PresetKey,
} from '@/entities/proxy-config';
import type { ThrottleState } from '@/shared/api';
import { setTheme, useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import { HostChipList, Select } from '@/shared/ui';

/**
 * Consolidated form for every global proxy toggle (issue #24's "Settings
 * panel"): Intercept, Focus, Throttle, Block Hosts, and the theme
 * preference. Each toggle already has its own quick-access toolbar
 * popover (`InterceptToggle`, `FocusControl`, …) — this doesn't replace
 * those, it's a single place to see and edit all of them together, backed
 * by the exact same stores (nothing here is a separate/parallel source of
 * truth).
 */
export function SettingsPanel() {
  return (
    <div className="space-y-5 text-sm">
      <AppearanceSection />
      <InterceptSection />
      <FocusSection />
      <ThrottleSection />
      <BlockHostsSection />
    </div>
  );
}

function SectionHeading({ children }: { children: string }) {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{children}</h3>;
}

function AppearanceSection() {
  const theme = useTheme();
  return (
    <section>
      <SectionHeading>Appearance</SectionHeading>
      <div className="flex gap-1.5">
        {(['dark', 'light'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTheme(option)}
            className={cn(
              'rounded-md border px-3 py-1 text-xs capitalize',
              theme === option
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--row-hover)]',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  );
}

function InterceptSection() {
  const interceptEnabled = useInterceptStore((s) => s.interceptEnabled);
  const setIntercept = useInterceptStore((s) => s.setIntercept);
  return (
    <section>
      <SectionHeading>Intercept</SectionHeading>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Master switch for the rule engine. Off drops the proxy to a plain relay (HTTPS becomes an unobservable TLS
        passthrough).
      </p>
      <button
        type="button"
        onClick={() => setIntercept(!interceptEnabled)}
        className={cn(
          'rounded-md border px-3 py-1 text-xs',
          interceptEnabled
            ? 'border-[var(--status-2xx)] text-[var(--status-2xx)]'
            : 'border-[var(--muted)] text-[var(--muted)]',
        )}
      >
        Intercept {interceptEnabled ? 'On' : 'Off'}
      </button>
    </section>
  );
}

function FocusSection() {
  const focusHosts = useFocusStore((s) => s.focusHosts);
  const setFocus = useFocusStore((s) => s.setFocus);
  return (
    <section>
      <SectionHeading>Focus</SectionHeading>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Restrict MITM interception to matching hosts (<code className="font-mono-ui">*</code>/
        <code className="font-mono-ui">?</code> wildcards). Empty means every host is intercepted.
      </p>
      <HostChipList hosts={focusHosts} onChange={setFocus} placeholder="api.example.com" featureLabel="Focus" />
    </section>
  );
}

function ThrottleSection() {
  const throttle = useThrottleStore((s) => s.throttle);
  const setThrottle = useThrottleStore((s) => s.setThrottle);

  const applyPreset = (key: PresetKey) => {
    if (key === 'custom') return;
    setThrottle({ ...throttle, enabled: true, ...PRESETS[key] });
  };
  const patch = (fields: Partial<Omit<ThrottleState, 'enabled'>>) => setThrottle({ ...throttle, ...fields });

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <SectionHeading>Throttle</SectionHeading>
        <button
          type="button"
          onClick={() => setThrottle({ ...throttle, enabled: !throttle.enabled })}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            throttle.enabled
              ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
              : 'border border-[var(--border)] text-[var(--muted)]',
          )}
        >
          {throttle.enabled ? 'On' : 'Off'}
        </button>
      </div>
      <Select
        value={presetFor(throttle)}
        onChange={(e) => applyPreset(e.target.value as PresetKey)}
        className="mb-2 w-full"
      >
        <option value="fast3g">Fast 3G</option>
        <option value="slow3g">Slow 3G</option>
        <option value="custom">Custom</option>
      </Select>
      <ThrottleFields throttle={throttle} onChange={patch} />
    </section>
  );
}

function BlockHostsSection() {
  const blockHosts = useBlockHostsStore((s) => s.blockHosts);
  const setBlockHosts = useBlockHostsStore((s) => s.setBlockHosts);
  const setHosts = (hosts: string[]) => setBlockHosts({ ...blockHosts, hosts });

  return (
    <section>
      <SectionHeading>Block Hosts</SectionHeading>
      <p className="mb-2 text-xs text-[var(--muted)]">Deny requests to matching hosts outright.</p>
      <Select
        value={blockHosts.mode}
        onChange={(e) => setBlockHosts({ ...blockHosts, mode: e.target.value as typeof blockHosts.mode })}
        className="mb-2 w-full"
      >
        <option value="forbidden">403 Forbidden</option>
        <option value="reset">Connection reset</option>
      </Select>
      <HostChipList
        hosts={blockHosts.hosts}
        onChange={setHosts}
        placeholder="api.example.com"
        featureLabel="Block Hosts"
      />
    </section>
  );
}
