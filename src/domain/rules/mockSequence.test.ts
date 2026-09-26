import { describe, expect, it } from 'vitest';
import { pickMockAction } from './mockSequence';
import type { MockAction } from './types';

describe('pickMockAction', () => {
  it('returns the action unchanged when responses is absent', () => {
    const action: MockAction = { type: 'mock', status: 200, body: { items: [] } };
    expect(pickMockAction(action, 0)).toBe(action);
    expect(pickMockAction(action, 5)).toBe(action);
  });

  it('returns the action unchanged when responses is an empty array', () => {
    const action: MockAction = { type: 'mock', status: 200, responses: [] };
    expect(pickMockAction(action, 0)).toBe(action);
  });

  it('picks responses[callIndex] for the 1st/2nd/3rd match', () => {
    const action: MockAction = {
      type: 'mock',
      responses: [{ body: { items: ['A'] } }, { body: { items: ['A', 'B'] } }, { body: { items: ['A', 'B', 'C'] } }],
    };
    expect(pickMockAction(action, 0).body).toEqual({ items: ['A'] });
    expect(pickMockAction(action, 1).body).toEqual({ items: ['A', 'B'] });
    expect(pickMockAction(action, 2).body).toEqual({ items: ['A', 'B', 'C'] });
  });

  it('keeps reusing the last entry once the sequence is exhausted', () => {
    const action: MockAction = {
      type: 'mock',
      responses: [{ status: 200 }, { status: 404 }],
    };
    expect(pickMockAction(action, 2).status).toBe(404);
    expect(pickMockAction(action, 99).status).toBe(404);
  });

  it('clamps a negative callIndex to the first entry', () => {
    const action: MockAction = { type: 'mock', responses: [{ status: 201 }, { status: 202 }] };
    expect(pickMockAction(action, -1).status).toBe(201);
  });

  it("falls back to the base action's own fields for anything a step omits", () => {
    const action: MockAction = {
      type: 'mock',
      status: 200,
      headers: { 'X-Base': '1' },
      responses: [{ status: 201 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.status).toBe(201);
    expect(picked.headers).toEqual({ 'X-Base': '1' });
  });

  it("a step's own body wins over the base action's bodyFile, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      bodyFile: 'base.json',
      responses: [{ body: { from: 'step' } }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.body).toEqual({ from: 'step' });
    expect(picked.bodyFile).toBeUndefined();
  });

  it("a step's own bodyFile wins over the base action's inline body, clearing it", () => {
    const action: MockAction = {
      type: 'mock',
      body: { from: 'base' },
      responses: [{ bodyFile: 'step.json' }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.bodyFile).toBe('step.json');
    expect(picked.body).toBeUndefined();
  });

  it("a step that sets neither body nor bodyFile inherits the base action's body untouched", () => {
    const action: MockAction = {
      type: 'mock',
      body: { from: 'base' },
      responses: [{ status: 201 }],
    };
    const picked = pickMockAction(action, 0);
    expect(picked.body).toEqual({ from: 'base' });
    expect(picked.bodyFile).toBeUndefined();
  });
});
