import { useState } from 'react';
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

  return (
    <>
      <div className={cn('h-full', !showSplash && 'app-float-in')}>
        <App />
      </div>
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
    </>
  );
}
