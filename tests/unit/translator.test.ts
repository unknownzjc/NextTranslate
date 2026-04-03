import { describe, it, expect } from 'vitest';
import { fnv1a } from '../../src/content/translator';

describe('fnv1a hash', () => {
  it('相同输入产生相同 hash', () => {
    const hash = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Simplified Chinese');
    expect(hash).toBe(hash2);
  });

  it('不同语言产生不同 hash', () => {
    const hash1 = fnv1a('hello\0Simplified Chinese');
    const hash2 = fnv1a('hello\0Japanese');
    expect(hash1).not.toBe(hash2);
  });
});
