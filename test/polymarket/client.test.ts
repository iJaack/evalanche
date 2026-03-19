import { describe, it, expect } from 'vitest';
import { PolymarketClient, POLYMARKET_CLOB_HOST, PolymarketSide } from '../../src/polymarket';

describe('Polymarket exports', () => {
  it('exposes public symbols', () => {
    expect(PolymarketClient).toBeDefined();
    expect(POLYMARKET_CLOB_HOST).toContain('polymarket');
    expect(PolymarketSide.BUY).toBe('BUY');
  });
});
