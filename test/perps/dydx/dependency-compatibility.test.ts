import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('round-trips real dYdX order identifiers with the patched protobuf runtime', () => {
  // Exercise the installed SDK, not the venue mocks. No wallet or network calls.
  const require = createRequire(import.meta.url);
  const sdk = require('@dydxprotocol/v4-client-js');
  expect(sdk.LocalWallet).toBeTypeOf('function');
  expect(sdk.CompositeClient).toBeTypeOf('function');
  const orderId = sdk.OrderId.fromPartial({
    subaccountId: { owner: 'dydx1test', number: 0 }, clientId: 1234, orderFlags: 32, clobPairId: 1,
  });
  const encoded = sdk.OrderId.encode(orderId).finish();
  expect(sdk.OrderId.decode(encoded)).toEqual(orderId);
});
