/**
 * Pinned KyberSwap routes for the treasury's enabled mainnets.
 *
 * A chain is listed only when three addresses were checked on 18 October 2026:
 * the Kyber MetaAggregationRouterV2 from the KyberSwap contract list, the
 * Li.Fi diamond from `GET https://li.quest/v1/chains`, and the wrapped native
 * from `GET https://li.quest/v1/token`. Each address had code on a public RPC.
 * `facets()` on each diamond included `swapTokensSingleV3ERC20ToERC20`
 * (`0x4666fc80`). `symbol()` on each wrapped native matched the symbol below.
 *
 * Router source: https://docs.kyberswap.com/developer-guide/aggregator-api/contracts
 * Slug source: https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps
 * Diamond source: https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses
 */

import { getAddress } from 'ethers';

export interface KyberRouteChain {
  chainId: number;
  /** Aggregator path slug. */
  slug: string;
  /** MetaAggregationRouterV2. */
  router: string;
  /** Li.Fi diamond. The V3 receiver is not this address. */
  diamond: string;
  /** Wrapped native ERC-20. Native itself stays the `0xeeee…` sentinel. */
  wrappedNative: string;
}

const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const CANONICAL_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

function route(
  chainId: number,
  slug: string,
  wrappedNative: string,
  diamond = CANONICAL_DIAMOND,
): KyberRouteChain {
  return {
    chainId,
    slug,
    router: getAddress(ROUTER),
    diamond: getAddress(diamond),
    wrappedNative: getAddress(wrappedNative),
  };
}

/**
 * Mainnets where Kyber and Li.Fi are both pinned. Sonic and HyperEVM are
 * in this list and stay off on the signer until config enables them.
 * Mantle and the other Kyber networks stay out.
 */
export const KYBER_ROUTE_CHAINS: readonly KyberRouteChain[] = [
  route(1, 'ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  route(10, 'optimism', '0x4200000000000000000000000000000000000006'),
  route(56, 'bsc', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),
  route(137, 'polygon', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'),
  route(146, 'sonic', '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38'),
  route(999, 'hyperevm', '0x5555555555555555555555555555555555555555', '0x0a0758d937d1059c356D4714e57F5df0239bce1A'),
  route(4663, 'robinhood', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', '0xB477751B76CF82d00a686A1232f5fCD772414Af3'),
  route(8453, 'base', '0x4200000000000000000000000000000000000006'),
  route(42161, 'arbitrum', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
  route(43114, 'avalanche', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'),
  route(59144, 'linea', '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', '0xDE1E598b81620773454588B85D6b5D4eEC32573e'),
  route(80094, 'berachain', '0x6969696969696969696969696969696969696969', '0xf909c4Ae16622898b885B89d7F839E0244851c66'),
];

const BY_ID = new Map(KYBER_ROUTE_CHAINS.map((chain) => [chain.chainId, chain]));

export const KYBER_ROUTE_CHAIN_IDS: readonly number[] = KYBER_ROUTE_CHAINS.map((chain) => chain.chainId);

export function kyberRouteChain(chainId: number): KyberRouteChain | undefined {
  return BY_ID.get(chainId);
}
