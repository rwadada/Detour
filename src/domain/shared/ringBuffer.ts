/**
 * A fixed-capacity, insertion-ordered buffer keyed by id.
 *
 * Backs both the dashboard server's backlog (recent exchanges replayed to a
 * newly-connected client) and the frontend's log store — in both places we
 * need the same two things a plain array doesn't give us cheaply: O(1)
 * "update this entry in place" (a `request` event is followed later by a
 * `response` event for the same id) and a hard cap on memory use once
 * traffic has been flowing for a while.
 *
 * Once at capacity, pushing a new id evicts the oldest entry. Updating an
 * existing id's value never changes its position.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private readonly keyOf: (item: T) => string;
  private readonly slotOfKey = new Map<string, number>();
  /** Index of the oldest occupied slot (meaningful only while `count > 0`). */
  private head = 0;
  /** Index the next brand-new entry will be written to. */
  private tail = 0;
  private count = 0;

  constructor(capacity: number, keyOf: (item: T) => string) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer (got: ${capacity})`);
    }
    this.slots = new Array(capacity);
    this.keyOf = keyOf;
  }

  get capacity(): number {
    return this.slots.length;
  }

  get size(): number {
    return this.count;
  }

  /** Inserts a new entry, or overwrites an existing one with the same key in place. */
  upsert(item: T): void {
    const key = this.keyOf(item);
    const existingSlot = this.slotOfKey.get(key);
    if (existingSlot !== undefined) {
      this.slots[existingSlot] = item;
      return;
    }

    if (this.count === this.capacity) {
      // Full: evict the oldest entry to make room.
      const evicted = this.slots[this.head];
      if (evicted !== undefined) this.slotOfKey.delete(this.keyOf(evicted));
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count -= 1;
    }

    const slot = this.tail;
    this.slots[slot] = item;
    this.slotOfKey.set(key, slot);
    this.tail = (this.tail + 1) % this.capacity;
    this.count += 1;
  }

  /** Returns all entries, oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.slots[(this.head + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.slotOfKey.clear();
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
