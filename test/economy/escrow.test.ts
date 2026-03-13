import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EscrowClient } from '../../src/economy/escrow';
import { EvalancheError } from '../../src/utils/errors';
import type { AgentSigner } from '../../src/wallet/signer';

// Mock wallet
function mockWallet(): AgentSigner {
  return {
    address: '0xClient1234567890000000000000000000000000',
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0xdeposithash',
      wait: vi.fn().mockResolvedValue({ hash: '0xdeposithash', status: 1 }),
    }),
    signMessage: vi.fn().mockResolvedValue('0xsig'),
  } as unknown as AgentSigner;
}

// Mock contract instance
function mockContract() {
  return {
    createJob: vi.fn().mockResolvedValue({
      hash: '0xdeposithash',
      wait: vi.fn().mockResolvedValue({ hash: '0xdeposithash', status: 1 }),
    }),
    completeJob: vi.fn().mockResolvedValue({
      hash: '0xreleasehash',
      wait: vi.fn().mockResolvedValue({ hash: '0xreleasehash', status: 1 }),
    }),
    refund: vi.fn().mockResolvedValue({
      hash: '0xrefundhash',
      wait: vi.fn().mockResolvedValue({ hash: '0xrefundhash', status: 1 }),
    }),
    disputeJob: vi.fn().mockResolvedValue({
      hash: '0xdisputehash',
      wait: vi.fn().mockResolvedValue({ hash: '0xdisputehash', status: 1 }),
    }),
    getEscrow: vi.fn().mockResolvedValue([
      '0xClient1234567890000000000000000000000000', // client
      '0xAgent0000000000000000000000000000000001',  // agent
      BigInt('500000000000000000'),                   // amount (0.5 ETH)
      BigInt(Math.floor(Date.now() / 1000) + 604800), // deadline (7 days)
      0,                                               // status: Active
    ]),
  };
}

// Mock ethers Contract constructor
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');
  const contractInstance = mockContract();
  return {
    ...actual as object,
    Contract: vi.fn().mockReturnValue(contractInstance),
    ContractFactory: vi.fn().mockReturnValue({
      deploy: vi.fn().mockResolvedValue({
        waitForDeployment: vi.fn().mockResolvedValue(undefined),
        getAddress: vi.fn().mockResolvedValue('0xEscrowContract000000000000000000000000'),
      }),
    }),
  };
});

describe('EscrowClient', () => {
  let escrow: EscrowClient;
  let contract: ReturnType<typeof mockContract>;

  beforeEach(async () => {
    const { Contract } = await import('ethers');
    escrow = new EscrowClient(mockWallet(), '0xEscrowContract000000000000000000000000');
    // Get the mock contract instance
    contract = (Contract as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? mockContract();
  });

  describe('hashJobId', () => {
    it('should produce consistent bytes32 hash from job ID string', () => {
      const hash1 = EscrowClient.hashJobId('job_abc123');
      const hash2 = EscrowClient.hashJobId('job_abc123');
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should produce different hashes for different job IDs', () => {
      const hash1 = EscrowClient.hashJobId('job_1');
      const hash2 = EscrowClient.hashJobId('job_2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('address', () => {
    it('should return the contract address', () => {
      expect(escrow.address).toBe('0xEscrowContract000000000000000000000000');
    });
  });

  describe('deposit', () => {
    it('should call createJob with correct parameters', async () => {
      const result = await escrow.deposit(
        'job_test1',
        '0xAgent0000000000000000000000000000000001',
        '0.5',
      );

      expect(result.txHash).toBe('0xdeposithash');
      expect(result.amount).toBe('0.5');
      expect(result.jobIdHash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should return a valid job ID hash', async () => {
      const result = await escrow.deposit(
        'job_test2',
        '0xAgent0000000000000000000000000000000001',
        '1.0',
      );
      expect(result.jobIdHash).toBe(EscrowClient.hashJobId('job_test2'));
    });

    it('should throw EvalancheError on failure', async () => {
      contract.createJob.mockRejectedValueOnce(new Error('insufficient funds'));

      await expect(
        escrow.deposit('job_fail', '0xAgent0000000000000000000000000000000001', '100'),
      ).rejects.toThrow(EvalancheError);
    });
  });

  describe('complete', () => {
    it('should call completeJob and return tx hash', async () => {
      const result = await escrow.complete('job_test1');
      expect(result.txHash).toBe('0xreleasehash');
    });

    it('should throw EvalancheError on failure', async () => {
      contract.completeJob.mockRejectedValueOnce(new Error('Not client'));

      await expect(escrow.complete('job_fail')).rejects.toThrow(EvalancheError);
    });
  });

  describe('refund', () => {
    it('should call refund and return tx hash', async () => {
      const result = await escrow.refund('job_test1');
      expect(result.txHash).toBe('0xrefundhash');
    });

    it('should throw EvalancheError on failure', async () => {
      contract.refund.mockRejectedValueOnce(new Error('Deadline not reached'));

      await expect(escrow.refund('job_early')).rejects.toThrow(EvalancheError);
    });
  });

  describe('dispute', () => {
    it('should call disputeJob and return tx hash', async () => {
      const result = await escrow.dispute('job_test1');
      expect(result.txHash).toBe('0xdisputehash');
    });

    it('should throw EvalancheError on failure', async () => {
      contract.disputeJob.mockRejectedValueOnce(new Error('Not party'));

      await expect(escrow.dispute('job_other')).rejects.toThrow(EvalancheError);
    });
  });

  describe('getEscrow', () => {
    it('should return escrow info with correct fields', async () => {
      const info = await escrow.getEscrow('job_test1');

      expect(info.jobId).toBe('job_test1');
      expect(info.client).toBe('0xClient1234567890000000000000000000000000');
      expect(info.agent).toBe('0xAgent0000000000000000000000000000000001');
      expect(info.amount).toBe('500000000000000000');
      expect(info.status).toBe('active');
      expect(info.deadline).toBeGreaterThan(0);
    });

    it('should map status enum correctly', async () => {
      // Status 1 = completed
      contract.getEscrow.mockResolvedValueOnce([
        '0xClient', '0xAgent', BigInt(100), BigInt(9999999999), 1,
      ]);
      const info = await escrow.getEscrow('job_done');
      expect(info.status).toBe('completed');
    });

    it('should throw EvalancheError on failure', async () => {
      contract.getEscrow.mockRejectedValueOnce(new Error('network error'));

      await expect(escrow.getEscrow('job_bad')).rejects.toThrow(EvalancheError);
    });
  });

  describe('deploy', () => {
    it('should deploy and return an EscrowClient', async () => {
      const client = await EscrowClient.deploy(mockWallet());
      expect(client).toBeInstanceOf(EscrowClient);
      expect(client.address).toBe('0xEscrowContract000000000000000000000000');
    });
  });
});
