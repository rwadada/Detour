import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

interface Item {
  id: string;
  value: number;
}

function buffer(capacity: number) {
  return new RingBuffer<Item>(capacity, (item) => item.id);
}

describe('RingBuffer', () => {
  it('returns entries in insertion order, oldest first', () => {
    const b = buffer(10);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'c', value: 3 });
    expect(b.toArray().map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('updates an existing key in place without changing its position', () => {
    const b = buffer(10);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'a', value: 99 });
    expect(b.toArray()).toEqual([
      { id: 'a', value: 99 },
      { id: 'b', value: 2 },
    ]);
    expect(b.size).toBe(2);
  });

  it('evicts the oldest entry once at capacity', () => {
    const b = buffer(2);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.upsert({ id: 'c', value: 3 });
    expect(b.toArray().map((i) => i.id)).toEqual(['b', 'c']);
    expect(b.size).toBe(2);
  });

  it('clear() empties the buffer and resets capacity tracking', () => {
    const b = buffer(2);
    b.upsert({ id: 'a', value: 1 });
    b.upsert({ id: 'b', value: 2 });
    b.clear();
    expect(b.toArray()).toEqual([]);
    expect(b.size).toBe(0);
    // Confirms internal slot bookkeeping was actually reset, not just the count.
    b.upsert({ id: 'c', value: 3 });
    b.upsert({ id: 'd', value: 4 });
    b.upsert({ id: 'e', value: 5 });
    expect(b.toArray().map((i) => i.id)).toEqual(['d', 'e']);
  });

  it('rejects a non-positive-integer capacity', () => {
    expect(() => buffer(0)).toThrow(/positive integer/);
    expect(() => buffer(-1)).toThrow(/positive integer/);
    expect(() => new RingBuffer<Item>(1.5, (i) => i.id)).toThrow(/positive integer/);
  });
});
