import { useState } from 'react';
import { AuthGate } from '@/widgets/auth-gate';
import { shouldSkipSplash, SplashScreen } from '@/widgets/splash-screen';
import { cn } from '@/shared/lib/utils';
import App from './App';

/**
 * Wraps `App` with the one-time startup splash (issue #24's design guide) —
 * kept as a separate component from `App` itself so `App` stays a pure
 * layout tree with no splash-timing concerns of its own.
 */
export default function AppShell() {
  const [showSplash, setShowSplash] = useState(() => !shouldSkipSplash());
  // Separate from `showSplash`: only true once the splash has actually
  // played and finished. When the splash is skipped outright, `showSplash`
  // starts `false` too — without this second flag, `!showSplash` would be
  // `true` from the very first render and `app-float-in` would still play
  // on the "no animation" path it's meant to skip.
  const [justRevealed, setJustRevealed] = useState(false);

  return (
    <>
      <div className={cn('h-full', justRevealed && 'app-float-in')}>
        <App />
      </div>
      <AuthGate />
      {showSplash && (
        <SplashScreen
          onDone={() => {
            setShowSplash(false);
            setJustRevealed(true);
          }}
        />
      )}
    </>
  );
}
