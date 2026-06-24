import { describe, it, expect } from 'vitest';
import { computeChecksum } from '../../src/sync/checksums.js';

describe('computeChecksum', () => {
  it('returns SHA-256 hex digest', () => {
    const result = computeChecksum(Buffer.from('hello'));
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns different checksums for different content', () => {
    const a = computeChecksum(Buffer.from('hello'));
    const b = computeChecksum(Buffer.from('world'));
    expect(a).not.toBe(b);
  });

  it('is deterministic', () => {
    const a = computeChecksum(Buffer.from('test'));
    const b = computeChecksum(Buffer.from('test'));
    expect(a).toBe(b);
  });
});
