/** x402 payment requirements parsed from a 402 response */
export interface PaymentRequirements {
  facilitator: string;
  paymentAddress: string;
  amount: string;
  currency: string;
  chainId: number;
  extra?: Record<string, unknown>;
}

/** Options for an x402 pay-and-fetch request */
export interface PayAndFetchOptions {
  maxPayment: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Result of an x402 pay-and-fetch request */
export interface PayAndFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  paymentHash?: string;
}
