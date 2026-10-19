export {
  canonicalIntentJson,
  canonicalJson,
  computeApprovedTxHash,
  computeIntentHash,
  computeMessageRouteHash,
  computeRequestRouteHash,
  computeRouteHash,
  generateEd25519KeyPair,
  isRemoteSignerConfig,
  isSigningProvider,
  signIntentHash,
  signVerifierApproval,
  verifyIntentHash,
} from './intent';
export type {
  CanonicalSigningRequest,
  Ed25519KeyPair,
  RemoteSignerConfig,
  SigningContext,
  SigningIntent,
  SigningKind,
  SigningProvider,
  SigningResult,
  TokenRef,
  TypedDataPayload,
  VerifierApproval,
  ApprovedTransaction,
  ApprovalDecision,
  ApprovalMode,
} from './intent';

export { RemoteSignerClient, assertSignedTransactionMatches, assertSigningResult } from './remote-client';
export {
  DelegatedEthersSigner,
  SIGNER_MODE,
  createDelegatedSigner,
  createReadOnlySigner,
  signerModeOf,
} from './ethers-adapter';
export type { SignerMode } from './ethers-adapter';
export {
  AUDIT_ROOT,
  EvalancheSignerServer,
  HARD_MAX_GAS_COST_WEI,
  startSignerServer,
} from './server';
export type { AllowEntry, ExplicitAllow, SignerServerOptions, TypedDataAllow } from './server';
export {
  buildCctpApprove,
  buildCctpBurn,
  buildCctpMint,
  buildPolymarketV1CtfRevoke,
  buildRevokeApproval,
  buildRevokeOperator,
} from './funding-intent';
export type { FundingIntentFields, PolymarketKillIntentFields } from './funding-intent';
