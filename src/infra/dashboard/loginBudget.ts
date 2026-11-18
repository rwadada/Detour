/**
 * Failed-login bookkeeping for one kind of key (a client address, or one
 * shared tally such as "every remote client"). `limit` failures lock the key
 * out; each lockout lasts twice as long as the one before it (from
 * `baseLockoutMs`, up to `maxLockoutMs`), and failures short of the limit
 * never decay with time.
 *
 * Both halves matter. A lockout that lasted until restart let any local
 * process (they all share 127.0.0.1) lock the owner out for good; one that
 * simply expired and reset the count let a client guess `limit - 1` times
 * per window forever. Escalating lockouts leave a mistyping owner waiting
 * minutes, while a guesser is held to a bounded number of tries a day.
 */
export interface LoginBudget {
  /** Whether `key` is locked out right now. */
  isLocked(key: string): boolean;
  /** Records one failure; returns the failures counted toward the current lockout (reaching `limit` locks the key). */
  recordFailure(key: string): number;
  /** Forgets `key` entirely (a successful login). */
  reset(key: string): void;
  /** Takes back one recorded failure (an attempt charged up front that turned out not to be a wrong guess). A lockout it already triggered stays. */
  refund(key: string): void;
  /** Clears `key`'s failures but keeps its lockout history, so its next lockout still escalates (a shared tally a success shouldn't wipe). An active lockout stays. */
  forgiveFailures(key: string): void;
}

interface Entry {
  failures: number;
  lockouts: number;
  lockedUntil: number;
}

export function createLoginBudget(options: {
  limit: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  /** How many keys are tracked at most; the least recently failed is forgotten first. */
  maxTracked: number;
  now: () => number;
}): LoginBudget {
  const { limit, baseLockoutMs, maxLockoutMs, maxTracked, now } = options;
  const entries = new Map<string, Entry>();

  /** The entry for `key`, with an elapsed lockout cleared (its failures start over; its lockout count stays). */
  const current = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry && entry.lockedUntil !== 0 && entry.lockedUntil <= now()) {
      entry.failures = 0;
      entry.lockedUntil = 0;
    }
    return entry;
  };

  /**
   * Makes room for one more key: the least recently failed one that isn't
   * locked out right now — forgetting a locked key would lift its lockout and
   * restart its escalation, which a client able to mint keys (an IPv6 range)
   * could do on purpose. Only if every tracked key is locked does the stalest go.
   */
  const evictOne = (): void => {
    for (const [key, entry] of entries) {
      if (entry.lockedUntil <= now()) {
        entries.delete(key);
        return;
      }
    }
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  };

  return {
    isLocked: (key) => (current(key)?.lockedUntil ?? 0) > now(),
    recordFailure(key) {
      const entry = current(key) ?? { failures: 0, lockouts: 0, lockedUntil: 0 };
      entry.failures++;
      if (entry.failures >= limit && entry.lockedUntil === 0) {
        entry.lockouts++;
        entry.lockedUntil = now() + Math.min(baseLockoutMs * 2 ** (entry.lockouts - 1), maxLockoutMs);
      }
      // Re-inserted so the Map stays ordered by last failure; the stalest goes first at the cap.
      entries.delete(key);
      if (entries.size >= maxTracked) evictOne();
      entries.set(key, entry);
      return entry.failures;
    },
    reset: (key) => {
      entries.delete(key);
    },
    refund: (key) => {
      const entry = current(key);
      if (entry && entry.failures > 0) entry.failures--;
    },
    forgiveFailures: (key) => {
      const entry = current(key);
      if (entry && entry.lockedUntil === 0) entry.failures = 0;
    },
  };
}
