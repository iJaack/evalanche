/** Default ERC-8004 identity registry address */
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** Default reputation registry address */
export const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

/** ABI for the identity registry contract */
export const IDENTITY_ABI = [
  'function tokenURI(uint256 agentId) view returns (string)',
  'function ownerOf(uint256 agentId) view returns (address)',
];

/** ABI for the reputation registry contract */
export const REPUTATION_ABI = [
  'function getReputation(uint256 agentId) view returns (uint256)',
  'function submitFeedback(uint256 targetAgentId, bytes32 interactionHash, uint256 score) external',
];

/** Domain separator for x402 reputation hashing */
export const DOMAIN_SEPARATOR = 'x402:8004-reputation:v1';
