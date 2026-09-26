/**
 * A `Map` with a hard entry cap that evicts the least-recently-used key once
 * it's full.
 *
 * Sits next to `RingBuffer` for the same reason that exists: a cache that
 * grows with whatever traffic happens to flow through the proxy needs a
 * bound, and pulling in a dependency for ~40 lines isn't worth it. The
 * difference is which end gets evicted — `RingBuffer` drops the oldest
 * *insertion* (it models a backlog, where age is the point), while this
 * drops the oldest *use* (it models a cache, where a host being hit over
 * and over should keep its entry no matter when it was first minted).
 *
 * Relies on JS `Map`'s guaranteed insertion order: a `get` that hits
 * re-inserts the entry at the back, so the front is always the LRU one
 * (`keys().next()`).
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LruMap capacity must be a positive integer (got: ${capacity})`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the value for `key` (marking it most-recently-used), or undefined. */
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move this key to the back of the iteration order. Guarded
    // by the `undefined` check above rather than `has` so the common miss
    // costs one lookup instead of two — `undefined` is never stored as a
    // value by any caller here.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Inserts (or refreshes) `key`, evicting the least-recently-used entry if that pushes past `capacity`. */
  set(key: K, value: V): void {
    // Delete first so a re-`set` of an existing key also counts as a use and
    // moves to the back, rather than keeping its original position.
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Keys in least- to most-recently-used order. */
  keys(): K[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}
