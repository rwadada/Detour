import { type FormEvent, useState } from 'react';
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
import { useUserConfigStore } from '@/entities/user-config';
import type { ThrottleState, UserConfigState } from '@/shared/api';
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
      <StartupDefaultsSection />
      <DashboardPasswordSection />
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
          // See InterceptToggle's comment: `--accent`, not `--status-2xx` (that token means "2xx
          // response" everywhere else it's used).
          interceptEnabled
            ? 'border-[var(--accent)] text-[var(--accent)]'
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

/**
 * Persistent `detour start` defaults (`defaultDetach`/`lanAccess`) — the
 * dashboard-side counterpart to `detour config`. Unlike every section
 * above, these aren't live proxy behavior a toggle here changes instantly:
 * both take effect on the *next* `detour start`, never this running
 * session, since a process's foreground/detached mode and a bound TCP
 * server's address are both fixed at spawn time. `userConfig` starts
 * `undefined` until the server's first message arrives right after
 * connecting — the toggles disable themselves until then rather than
 * guessing a value that might immediately flip.
 *
 * The LAN warning text below is hand-matched to the CLI's own
 * `LAN_ACCESS_WARNING` constant (`src/cli.ts`) — this is a separate,
 * standalone-built package with no access to that constant, so update both
 * together if the wording (or the security posture it describes) changes.
 */
function StartupDefaultsSection() {
  const userConfig = useUserConfigStore((s) => s.userConfig);
  const setUserConfig = useUserConfigStore((s) => s.setUserConfig);

  const toggle = (key: keyof UserConfigState, label: string, dangerous = false) => {
    const on = userConfig?.[key] ?? false;
    const onColor = dangerous
      ? 'border-[var(--status-5xx)] text-[var(--status-5xx)]'
      : 'border-[var(--accent)] text-[var(--accent)]';
    return (
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--muted)]">{label}</span>
        <button
          type="button"
          onClick={() => setUserConfig({ [key]: !on })}
          disabled={!userConfig}
          aria-pressed={on}
          aria-label={`${label}: ${on ? 'on' : 'off'}`}
          className={cn(
            'rounded-md border px-3 py-1 text-xs disabled:opacity-50',
            on ? onColor : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--row-hover)]',
          )}
        >
          {on ? 'On' : 'Off'}
        </button>
      </div>
    );
  };

  return (
    <section>
      <SectionHeading>Startup defaults</SectionHeading>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Persisted to <code className="font-mono-ui">~/.detour/config.json</code> (same as{' '}
        <code className="font-mono-ui">detour config</code>) — takes effect on the{' '}
        <span className="font-medium text-[var(--foreground)]">next</span>{' '}
        <code className="font-mono-ui">detour start</code>, not this running session.
      </p>
      <div className="flex flex-col gap-2">
        {toggle('defaultDetach', 'Run detached by default')}
        {/* The warning sits between the two toggles, not after both: a reader scanning top-to-bottom
            reaches it before "Allow LAN access" itself, instead of after already having a chance to
            flip it on unread. Boxed (border + tinted background) rather than plain paragraph text so
            it reads as an alert instead of another line of muted help copy easy to skim past. */}
        <p
          role="alert"
          className="rounded-md border border-[var(--status-5xx)] bg-[var(--status-5xx)]/10 px-2.5 py-2 text-xs text-[var(--status-5xx)]"
        >
          ⚠ LAN access has no login of any kind — anyone on your network could reach the dashboard, view decrypted HTTPS
          traffic through it, or edit rules. (The proxy itself is always reachable from your network regardless of this
          setting — a proxy nothing else on the network can reach isn't much of a proxy.) Only turn this on if you trust
          every device on your network.
        </p>
        {toggle('lanAccess', 'Allow LAN access', true)}
      </div>
    </section>
  );
}

/**
 * The optional dashboard password (issue #66) — unlike `StartupDefaultsSection`
 * above, this isn't a `detour start`-time setting: it gates the `/ws`
 * connection itself (see `dashboardServer.ts`'s `login`/`authRequired`), so a
 * change here takes effect for new connections immediately, no restart
 * needed. A separate section (not folded into `StartupDefaultsSection`)
 * specifically to avoid implying that "next start only" caveat applies here
 * too. The password itself is never round-tripped back from the server —
 * only whether one is currently set (`dashboardPasswordSet`) — so this can
 * only ever show On/Off, never the value.
 */
function DashboardPasswordSection() {
  const userConfig = useUserConfigStore((s) => s.userConfig);
  const setDashboardPassword = useUserConfigStore((s) => s.setDashboardPassword);
  const [value, setValue] = useState('');
  const passwordSet = userConfig?.dashboardPasswordSet ?? false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setDashboardPassword(value);
    setValue('');
  };

  return (
    <section>
      <SectionHeading>Dashboard password</SectionHeading>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Require this password before the dashboard will send any traffic, rules, or accept any control message.
        Independent of LAN access — meant to be paired with it, but works for a localhost-only session too.
      </p>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-[var(--muted)]">Password protection</span>
        <span
          className={cn(
            'rounded-md border px-3 py-1 text-xs',
            passwordSet ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)]',
          )}
        >
          {passwordSet ? 'On' : 'Off'}
        </span>
      </div>
      <form onSubmit={submit} className="flex gap-1.5">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={passwordSet ? 'New password' : 'Set a password'}
          disabled={!userConfig}
          autoComplete="new-password"
          aria-label="Dashboard password"
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!userConfig || !value}
          className="shrink-0 rounded-md border border-[var(--accent)] px-3 py-1 text-xs text-[var(--accent)] disabled:opacity-50"
        >
          {passwordSet ? 'Update' : 'Set'}
        </button>
        {passwordSet && (
          <button
            type="button"
            onClick={() => setDashboardPassword(null)}
            disabled={!userConfig}
            className="shrink-0 rounded-md border border-[var(--status-5xx)] px-3 py-1 text-xs text-[var(--status-5xx)] disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </form>
    </section>
  );
}
