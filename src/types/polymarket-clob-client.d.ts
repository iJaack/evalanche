declare module '@polymarket/clob-client' {
  export interface ClobApiCreds {
    key: string;
    secret: string;
    passphrase?: string;
  }

  export class ClobClient {
    constructor(host: string, chainId: number, signer?: unknown, apiCreds?: unknown, signatureType?: number, funder?: string);
    getMarkets(options?: unknown): Promise<any>;
    getMarket(conditionId: string): Promise<any>;
    getOrderBook(tokenId: string): Promise<any>;
    createAndPostOrder(order: unknown, options?: unknown): Promise<any>;
    cancelOrder(orderId: string): Promise<any>;
    getOrder(orderId: string): Promise<any>;
    getOpenOrders(tokenId?: string): Promise<any[]>;
    getPositions?(): Promise<any[]>;
    getBalances?(): Promise<any>;
    getBalanceAllowance?(params: { asset_type: 'COLLATERAL' | 'CONDITIONAL'; token_id?: string }): Promise<any>;
    getTrades(tokenId?: string): Promise<any[]>;
    deriveApiKey?(): Promise<ClobApiCreds>;
    createOrDeriveApiKey?(): Promise<ClobApiCreds>;
  }

  export const Side: {
    BUY: string;
    SELL: string;
  };
}
