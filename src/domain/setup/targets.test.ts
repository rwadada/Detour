import { describe, expect, it } from 'vitest';
import { isSetupTarget, SETUP_TARGETS } from './targets';

describe('isSetupTarget', () => {
  it('accepts every declared target', () => {
    for (const target of SETUP_TARGETS) expect(isSetupTarget(target)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSetupTarget('macos')).toBe(false);
    expect(isSetupTarget('')).toBe(false);
    expect(isSetupTarget('ANDROID')).toBe(false);
  });
});
