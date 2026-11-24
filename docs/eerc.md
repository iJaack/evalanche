# Private payments with eERC

Evalanche agents can pay each other privately through [eERC](https://github.com/ava-labs/EncryptedERC), Ava Labs' encrypted token standard. Balances and transfer amounts are encrypted on chain. Sender and recipient addresses stay public, and the contract's auditor can decrypt every transfer.

This integration supports converter mode: an existing ERC-20 is deposited into an encrypted balance, sent privately, and withdrawn back.

| | Public | Private |
| --- | --- | --- |
| Deposit (ERC-20 into eERC) | sender, amount | |
| Private transfer | sender, recipient | amount, balances, optional memo |
| Withdraw (eERC back to ERC-20) | recipient, amount | remaining balance |

Deposit ciphertexts use fixed randomness, so a balance only becomes confidential once the account receives a private transfer (see the EncryptedERC docs).

## Before you use it

- **Avalanche only.** eERC ships under Ava Labs' Ecosystem License, which covers Avalanche chains. The client refuses any chain other than C-Chain (43114) and Fuji (43113).
- **Testnet until production keys exist.** EncryptedERC #80 (August 2026) fixed circuit soundness bugs and noted that production verification keys must come from a new multi-party ceremony. Until Ava Labs publishes ceremony keys, use eERC on Fuji with keys from your own setup, not with real funds.
- **Local key only.** Proofs and decryption need the key in the agent process. A remote signer cannot sign eERC calls; the external signer denies them because encrypted amounts cannot be checked against its caps.

## Install

The prover is an optional peer dependency, so it is not installed with evalanche:

```bash
npm install evalanche @avalabs/eerc-sdk
```

The SDK's package also pulls `react` and `wagmi` as peers. Nothing renders; its bundle imports them at load time.

## Circuit files

The client needs the register, transfer and withdraw artifacts that match the contract's verifiers, laid out as:

```
circuits/
  register/circuit.wasm   register/circuit.zkey
  transfer/circuit.wasm   transfer/circuit.zkey
  withdraw/circuit.wasm   withdraw/circuit.zkey
```

Together they are about 30 MB. `eercCircuitsFromDir(dir)` builds the config from that layout.

## Use it from code

```ts
import { Evalanche, eercCircuitsFromDir } from 'evalanche';

const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY!, network: 'fuji' });
const eerc = agent.eerc({
  contract: '0x…',                       // EncryptedERC in converter mode
  circuits: eercCircuitsFromDir('./circuits'),
  maxAmount: '100',                      // optional cap per deposit, transfer or withdraw
});

await eerc.register();                   // once per address
await eerc.deposit(USDC, '50');          // public amount in
await eerc.transfer(peer, USDC, '12.5', 'invoice 42'); // private amount
console.log(await eerc.balance(USDC));   // { amount: '37.5', … }
await eerc.withdraw(USDC, '10');         // public amount out
await eerc.close();                      // let a script exit; the shared prover stops when the last client closes
```

Amounts are decimal strings in token units. They may not carry more decimals than the contract's own (`decimals()`, 2 in the reference deployment); the client refuses them instead of letting the contract refund dust.

The decryption key is derived from a wallet signature over the SDK's registration message, so the same private key always recovers the same balance. Pass `decryptionKey` to skip the signature.

## MCP tools

| Tool | What it does |
| --- | --- |
| `eerc_register` | Register the agent for private payments |
| `eerc_balance` | Decrypt the private balance of a token |
| `eerc_deposit` | Move public tokens into the private balance |
| `eerc_transfer` | Send a private amount to a registered address, with an optional encrypted memo |
| `eerc_withdraw` | Move tokens back to the public balance |

Configure them with environment variables:

| Variable | Meaning |
| --- | --- |
| EVALANCHE_EERC_CONTRACT | Default eERC contract (each tool also takes a contract argument) |
| EVALANCHE_EERC_CIRCUITS_DIR | Folder with the circuit layout above |
| EVALANCHE_EERC_MAX_AMOUNT | Optional cap per payment, in token units |

The SDK logs with console.log. The client routes that output to stderr so the stdio MCP stream stays clean.

## Safety behaviour

- **One write at a time.** A spend proof is bound to the current encrypted balance, and the contract rejects any proof built against a balance that has since been spent from. The client queues deposits, transfers and withdrawals, and re-reads and decrypts the balance before every proof.
- **Spending policy.** Every transaction the client broadcasts (approval, register, deposit, transfer, withdraw, auditor change) is checked against the agent's policy with its real signed calldata just before it is sent, so chain and contract allowlists, function-selector allowlists and `simulateBeforeSend` all apply. A rejected transaction is never broadcast, and the policy error is returned as is. The agent knows the plaintext amount it is sending, so `maxAmount` is enforced before a proof is built, even though the amount is encrypted on chain.
- **Clear failures.** Unregistered sender or recipient, a contract without an auditor, an insufficient private balance and reverted transactions all fail with typed errors before or after the transaction, not as raw revert data.

## Limits from eERC itself

- A private transfer costs about 947k gas and registration about 322k (EncryptedERC README).
- An account can hold at most 300 unspent incoming credits; after that, payments to it revert until it spends.
- Registration cannot be repeated or rotated. Losing the private key loses the private balance.
- A payment cannot be proved in advance and sent later: any outgoing transfer or withdrawal invalidates earlier proofs.
