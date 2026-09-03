import { describe, expect, it } from 'vitest';
import {
  blankAction,
  blankBodyReplace,
  bodyRewriteMode,
  bodyValueToText,
  isEmptySetRemove,
  parseBodyValue,
  parseOptionalInt,
  removeListToText,
  setMapToText,
  textToRemoveList,
  textToSetMap,
} from './actionFields';

describe('blankAction', () => {
  it('produces a mock action defaulting to status 200', () => {
    expect(blankAction('mock')).toEqual({ type: 'mock', status: 200 });
  });

  it('produces a route action with a blank host', () => {
    expect(blankAction('route')).toEqual({ type: 'route', host: '' });
  });

  it('produces a bare rewrite action', () => {
    expect(blankAction('rewrite')).toEqual({ type: 'rewrite' });
  });

  it('produces a bare breakpoint action', () => {
    expect(blankAction('breakpoint')).toEqual({ type: 'breakpoint' });
  });

  it('produces a script action with a blank path', () => {
    expect(blankAction('script')).toEqual({ type: 'script', path: '' });
  });
});

describe('setMapToText / textToSetMap', () => {
  it('round-trips a header map through "Name: value" lines', () => {
    const map = { 'X-A': '1', 'X-B': '2' };
    expect(textToSetMap(setMapToText(map))).toEqual(map);
  });

  it('returns undefined (not {}) for blank text', () => {
    expect(textToSetMap('')).toBeUndefined();
    expect(textToSetMap('   \n  ')).toBeUndefined();
  });

  it('renders an empty/undefined map as an empty string', () => {
    expect(setMapToText(undefined)).toBe('');
    expect(setMapToText({})).toBe('');
  });
});

describe('removeListToText / textToRemoveList', () => {
  it('round-trips a name list through a comma-separated line', () => {
    expect(textToRemoveList(removeListToText(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('trims each name and drops empties', () => {
    expect(textToRemoveList(' a ,, b ,')).toEqual(['a', 'b']);
  });

  it('returns undefined (not []) for blank text', () => {
    expect(textToRemoveList('')).toBeUndefined();
    expect(textToRemoveList('  ,  ,')).toBeUndefined();
  });
});

describe('isEmptySetRemove', () => {
  it('is true for undefined', () => {
    expect(isEmptySetRemove(undefined)).toBe(true);
  });

  it('is true for an object with empty set/remove', () => {
    expect(isEmptySetRemove({ set: {}, remove: [] })).toBe(true);
  });

  it('is false when set has entries', () => {
    expect(isEmptySetRemove({ set: { a: '1' } })).toBe(false);
  });

  it('is false when remove has entries', () => {
    expect(isEmptySetRemove({ remove: ['a'] })).toBe(false);
  });
});

describe('parseBodyValue / bodyValueToText', () => {
  it('parses valid JSON into its value', () => {
    expect(parseBodyValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseBodyValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseBodyValue('42')).toBe(42);
  });

  it('keeps non-JSON text as a plain string', () => {
    expect(parseBodyValue('hello world')).toBe('hello world');
  });

  it('returns undefined for blank text', () => {
    expect(parseBodyValue('')).toBeUndefined();
    expect(parseBodyValue('   ')).toBeUndefined();
  });

  it('round-trips an object through bodyValueToText/parseBodyValue', () => {
    const value = { id: 1, name: 'x' };
    expect(parseBodyValue(bodyValueToText(value))).toEqual(value);
  });

  it('round-trips a plain string unchanged', () => {
    expect(bodyValueToText('plain text')).toBe('plain text');
    expect(parseBodyValue('plain text')).toBe('plain text');
  });

  it('renders undefined as an empty string', () => {
    expect(bodyValueToText(undefined)).toBe('');
  });
});

describe('bodyRewriteMode', () => {
  it('is "none" for undefined', () => {
    expect(bodyRewriteMode(undefined)).toBe('none');
  });

  it('is "set" when set is present', () => {
    expect(bodyRewriteMode({ set: { a: 1 } })).toBe('set');
  });

  it('is "transform" when replace has entries', () => {
    expect(bodyRewriteMode({ replace: [{ find: 'a', replacement: 'b' }] })).toBe('transform');
  });

  it('is "transform" when merge is present', () => {
    expect(bodyRewriteMode({ merge: { a: 1 } })).toBe('transform');
  });

  it('is "transform" when both replace and merge are present (they compose — see the type\'s doc comment)', () => {
    expect(bodyRewriteMode({ replace: [{ find: 'a', replacement: 'b' }], merge: { a: 1 } })).toBe('transform');
  });

  it('is "none" for an empty replace array', () => {
    expect(bodyRewriteMode({ replace: [] })).toBe('none');
  });

  it('prefers set over replace/merge when multiple are (unusually) present', () => {
    expect(bodyRewriteMode({ set: 'x', merge: { a: 1 } })).toBe('set');
  });
});

describe('blankBodyReplace', () => {
  it('produces an empty find/replacement row', () => {
    expect(blankBodyReplace()).toEqual({ find: '', replacement: '' });
  });
});

describe('parseOptionalInt', () => {
  it('treats blank text as unset', () => {
    expect(parseOptionalInt('')).toBeUndefined();
    expect(parseOptionalInt('   ')).toBeUndefined();
  });

  it('parses a valid integer', () => {
    expect(parseOptionalInt('8080')).toBe(8080);
  });

  it('preserves an explicit 0 rather than treating it as unset', () => {
    expect(parseOptionalInt('0')).toBe(0);
  });

  it('returns undefined for non-numeric text', () => {
    expect(parseOptionalInt('abc')).toBeUndefined();
  });
});
