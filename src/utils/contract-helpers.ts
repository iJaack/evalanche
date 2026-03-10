import { Contract } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from './errors';

const ERC20_ABI = ['function approve(address spender, uint256 amount) external returns (bool)'] as const;
const UUPS_ABI = ['function upgradeToAndCall(address newImplementation, bytes data) external'] as const;

export interface ApproveAndCallData {
  to?: string;
  data: string;
  value?: bigint;
  gasLimit?: bigint;
}

export interface ApproveAndCallResult {
  approveTxHash: string;
  callTxHash: string;
  success: boolean;
}

export interface UpgradeProxyResult {
  txHash: string;
  success: boolean;
}

export async function approveAndCall(
  signer: AgentSigner,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
  contractCallData: string | ApproveAndCallData,
): Promise<ApproveAndCallResult> {
  try {
    const erc20 = new Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await erc20.approve(spenderAddress, amount);
    const approveReceipt = await approveTx.wait();

    if (!approveReceipt || approveReceipt.status !== 1) {
      throw new Error('Approve transaction failed');
    }

    const callData = typeof contractCallData === 'string'
      ? { to: spenderAddress, data: contractCallData }
      : { to: contractCallData.to ?? spenderAddress, ...contractCallData };

    const callTx = await signer.sendTransaction({
      to: callData.to,
      data: callData.data,
      value: callData.value,
      gasLimit: callData.gasLimit,
    });

    const callReceipt = await callTx.wait();
    if (!callReceipt || callReceipt.status !== 1) {
      throw new Error('Contract call transaction failed');
    }

    return {
      approveTxHash: approveTx.hash,
      callTxHash: callTx.hash,
      success: true,
    };
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    throw new EvalancheError(
      `approveAndCall failed: ${error instanceof Error ? error.message : String(error)}`,
      EvalancheErrorCode.CONTRACT_CALL_FAILED,
      error instanceof Error ? error : undefined,
    );
  }
}

export async function upgradeProxy(
  signer: AgentSigner,
  proxyAddress: string,
  newImplementationAddress: string,
  initData?: string,
): Promise<UpgradeProxyResult> {
  try {
    const proxy = new Contract(proxyAddress, UUPS_ABI, signer);
    const tx = await proxy.upgradeToAndCall(newImplementationAddress, initData ?? '0x');
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error('Proxy upgrade transaction failed');
    }

    return {
      txHash: tx.hash,
      success: true,
    };
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    throw new EvalancheError(
      `upgradeProxy failed: ${error instanceof Error ? error.message : String(error)}`,
      EvalancheErrorCode.CONTRACT_CALL_FAILED,
      error instanceof Error ? error : undefined,
    );
  }
}
