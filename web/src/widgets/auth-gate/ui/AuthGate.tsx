import { type FormEvent, useState } from 'react';
import { getDashboardConnection } from '@/shared/api';
import { DetourLogo } from '@/shared/ui';
import { createAuthGateStore } from '../model/createAuthGateStore';

// The app's real auth-gate store, wired to the real dashboard connection —
// defined here (this component's only consumer) rather than in
// `model/createAuthGateStore.ts`, so importing that module never has the
// side effect of opening a real WebSocket. Mirrors `ui/Sidebar.tsx`'s own
// `useProxyInfoStore`.
const useAuthGateStore = createAuthGateStore(getDashboardConnection());

/**
 * Full-screen overlay blocking the dashboard while the optional password
 * (issue #66) hasn't been supplied yet. Renders nothing for `'unknown'` (the
 * brief moment before the first server message arrives) as well as
 * `'unlocked'` — a real connection resolves out of `'unknown'` almost
 * instantly either way, so `App` underneath is never visible with genuinely
 * missing data for longer than that.
 */
export function AuthGate() {
  const status = useAuthGateStore((s) => s.status);
  const error = useAuthGateStore((s) => s.error);
  const login = useAuthGateStore((s) => s.login);
  const [password, setPassword] = useState('');

  if (status !== 'locked') return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    login(password);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-gate-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[var(--background)]"
    >
      <DetourLogo className="h-12 w-12 rounded-2xl" decorative />
      <div id="auth-gate-title" className="text-sm font-semibold tracking-tight">
        Dashboard password required
      </div>
      <form onSubmit={submit} className="flex w-56 flex-col items-stretch gap-2">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Dashboard password"
          className="rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={!password}
          className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent)] disabled:opacity-50"
        >
          Unlock
        </button>
        {error && (
          <p role="alert" className="text-center text-xs text-[var(--status-5xx)]">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
