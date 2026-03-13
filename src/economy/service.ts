import { verifyMessage } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Configuration for a payment-gated endpoint */
export interface ServiceEndpoint {
  /** URL path for this endpoint (e.g. "/audit") */
  path: string;
  /** Price per call in human-readable units (e.g. "0.01" for 0.01 ETH) */
  price: string;
  /** Currency symbol (e.g. "ETH", "AVAX") */
  currency: string;
  /** Chain ID where payments are accepted */
  chainId: number;
  /** The handler function that produces the response content */
  handler: (body?: string) => Promise<string> | string;
}

/** A received and verified payment */
export interface ReceivedPayment {
  /** Payer's address */
  from: string;
  /** Amount in human-readable units */
  amount: string;
  /** Currency symbol */
  currency: string;
  /** Chain ID */
  chainId: number;
  /** Endpoint path that was paid for */
  path: string;
  /** Unix timestamp (ms) when the payment was received */
  timestamp: number;
}

/** Revenue summary */
export interface RevenueSummary {
  /** Total number of paid requests served */
  totalRequests: number;
  /** Payments grouped by endpoint path */
  byEndpoint: Record<string, { count: number; payments: ReceivedPayment[] }>;
}

/**
 * AgentServiceHost enables an agent to serve payment-gated endpoints.
 * This is the server-side complement to x402 — instead of paying for content,
 * this agent RECEIVES payment and provides content.
 *
 * Flow (from the caller's perspective):
 * 1. Caller hits the endpoint
 * 2. Agent responds with 402 + payment requirements
 * 3. Caller signs a payment proof and retries
 * 4. Agent verifies the proof signature and serves the response
 *
 * Usage:
 * ```ts
 * const host = new AgentServiceHost('0xAgentAddress');
 *
 * host.serve({
 *   path: '/audit',
 *   price: '0.01',
 *   currency: 'ETH',
 *   chainId: 8453,
 *   handler: async (body) => JSON.stringify({ result: 'audit complete' }),
 * });
 *
 * // When a request comes in:
 * const response = await host.handleRequest('/audit', undefined, paymentProof);
 * ```
 */
export class AgentServiceHost {
  private readonly _agentAddress: string;
  private readonly _endpoints: Map<string, ServiceEndpoint> = new Map();
  private readonly _payments: ReceivedPayment[] = [];

  constructor(agentAddress: string) {
    this._agentAddress = agentAddress;
  }

  /**
   * Register a payment-gated endpoint.
   * If an endpoint with the same path already exists, it is replaced.
   */
  serve(endpoint: ServiceEndpoint): void {
    if (!endpoint.path || !endpoint.price || !endpoint.handler) {
      throw new EvalancheError(
        'Endpoint requires path, price, and handler',
        EvalancheErrorCode.DISCOVERY_ERROR,
      );
    }
    this._endpoints.set(endpoint.path, { ...endpoint, handler: endpoint.handler });
  }

  /** Remove an endpoint by path. Returns true if found and removed. */
  unserve(path: string): boolean {
    return this._endpoints.delete(path);
  }

  /** List all active endpoints (without handler functions) */
  listEndpoints(): Array<Omit<ServiceEndpoint, 'handler'>> {
    return Array.from(this._endpoints.values()).map(({ handler, ...rest }) => rest);
  }

  /**
   * Handle an incoming request to a payment-gated endpoint.
   *
   * - If no payment proof: returns a 402 challenge with requirements.
   * - If valid payment proof: executes the handler and returns the content.
   * - If invalid proof: returns an error.
   *
   * @param path - Endpoint path
   * @param body - Optional request body
   * @param paymentProof - Base64-encoded payment proof (from x-payment-proof header)
   * @returns Object with status code and body
   */
  async handleRequest(
    path: string,
    body?: string,
    paymentProof?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const endpoint = this._endpoints.get(path);
    if (!endpoint) {
      return { status: 404, headers: {}, body: JSON.stringify({ error: `No endpoint at ${path}` }) };
    }

    // No payment proof — return 402 challenge
    if (!paymentProof) {
      const requirements = {
        facilitator: this._agentAddress,
        paymentAddress: this._agentAddress,
        amount: endpoint.price,
        currency: endpoint.currency,
        chainId: endpoint.chainId,
      };
      return {
        status: 402,
        headers: { 'x-payment-requirements': JSON.stringify(requirements) },
        body: JSON.stringify({ error: 'Payment required', requirements }),
      };
    }

    // Verify payment proof
    const verification = this._verifyPaymentProof(paymentProof, endpoint);
    if (!verification.valid) {
      return {
        status: 403,
        headers: {},
        body: JSON.stringify({ error: verification.reason }),
      };
    }

    // Record the payment
    this._payments.push({
      from: verification.payer!,
      amount: endpoint.price,
      currency: endpoint.currency,
      chainId: endpoint.chainId,
      path,
      timestamp: Date.now(),
    });

    // Execute the handler
    const content = await endpoint.handler(body);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: content,
    };
  }

  /** Get revenue summary across all endpoints */
  getRevenue(): RevenueSummary {
    const byEndpoint: RevenueSummary['byEndpoint'] = {};

    for (const payment of this._payments) {
      if (!byEndpoint[payment.path]) {
        byEndpoint[payment.path] = { count: 0, payments: [] };
      }
      byEndpoint[payment.path].count++;
      byEndpoint[payment.path].payments.push(payment);
    }

    return {
      totalRequests: this._payments.length,
      byEndpoint,
    };
  }

  /** Get total payments received */
  get paymentCount(): number {
    return this._payments.length;
  }

  /**
   * Verify a base64-encoded x402 payment proof.
   * Checks: (1) valid JSON, (2) valid signature, (3) correct payment address,
   * (4) sufficient amount, (5) correct chain.
   */
  private _verifyPaymentProof(
    proof: string,
    endpoint: ServiceEndpoint,
  ): { valid: boolean; payer?: string; reason?: string } {
    try {
      const decoded = JSON.parse(Buffer.from(proof, 'base64').toString('utf-8'));
      const { payload, signature } = decoded;

      if (!payload || !signature) {
        return { valid: false, reason: 'Missing payload or signature in proof' };
      }

      // Verify the signature recovers to a valid address
      const message = JSON.stringify(payload);
      const recoveredAddress = verifyMessage(message, signature);

      // Check payment is addressed to this agent
      if (payload.paymentAddress?.toLowerCase() !== this._agentAddress.toLowerCase()) {
        return { valid: false, reason: 'Payment not addressed to this agent' };
      }

      // Check chain ID matches
      if (payload.chainId !== endpoint.chainId) {
        return { valid: false, reason: `Wrong chain: expected ${endpoint.chainId}, got ${payload.chainId}` };
      }

      // Check payment amount is sufficient (reject NaN / non-numeric values)
      const paidAmount = Number(payload.amount);
      const requiredAmount = Number(endpoint.price);
      if (!Number.isFinite(paidAmount) || !Number.isFinite(requiredAmount) || paidAmount < requiredAmount) {
        return { valid: false, reason: `Insufficient payment: expected ${endpoint.price} ${endpoint.currency}, got ${payload.amount ?? '0'}` };
      }

      // Proof is valid
      return { valid: true, payer: recoveredAddress };
    } catch {
      return { valid: false, reason: 'Invalid payment proof format' };
    }
  }
}
