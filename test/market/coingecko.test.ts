import { describe, it, expect } from 'vitest';
import { CoinGeckoClient } from '../../src/market/coingecko';

describe('CoinGeckoClient', () => {
  it('constructs', () => {
    expect(new CoinGeckoClient()).toBeInstanceOf(CoinGeckoClient);
  });
});
