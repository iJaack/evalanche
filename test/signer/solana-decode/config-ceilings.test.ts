import { describe, expect, it } from 'vitest';
import policyVectors from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, configModule, decode, expectDeny, MAINNET, mod, policyContext, requireFn, template, USDC, USDT, WSOL } from './helpers';
const ceilings:[string,number|string,number|string,number|string][]=[
  ['fees.maxComputeUnitLimit',400000,399999,400001],
  ['fees.maxComputeUnitPriceMicroLamports','2500000','2499999','2500001'],
  ['fees.maxPriorityFeeLamports','1000000','999999','1000001'],
  ['maxRentLamports','3000000','2999999','3000001'],
];
function parent(c:any,path:string){const parts=path.split('.');const name=parts.pop()!;return {object:parts.reduce((o,p)=>o[p],c),name};}
describe('explicit economics: hard ceilings apply even while dormant',()=>{
  for(const enabled of [true,false])for(const [path,ceiling,lower,above]of ceilings){
    for(const [label,value]of [['at ceiling',ceiling],['lower',lower]]as const)it(`${enabled?'enabled':'dormant'} ${path} ${label} accepted`,()=>{
      const resolve=requireFn(configModule,'resolveSolanaConfig');const input=template(enabled);const p=parent(input.clusters[MAINNET],path);p.object[p.name]=value;
      const c=resolve(input).clusters[MAINNET];const r=parent(c,path);expect(r.object[r.name]).toBe(value);
    });
    it(`${enabled?'enabled':'dormant'} ${path} +1 rejected at resolve`,()=>{
      const resolve=requireFn(configModule,'resolveSolanaConfig');const input=template(enabled);const p=parent(input.clusters[MAINNET],path);p.object[p.name]=above;
      // Startup validation retains the existing config-error API; request-time denials use expectDeny.
      expect(()=>resolve(input)).toThrow(/SOL_DENY_CONFIG_ABOVE_CEILING/);
    });
  }
  for(const enabled of [true,false]){
    it.each(['2','2.00','2.000000','0','0.50'])('maxFeeUsd %s accepted '+(enabled?'enabled':'dormant'),value=>{
      const resolve=requireFn(configModule,'resolveSolanaConfig');const input=template(enabled);input.clusters[MAINNET].fees.maxFeeUsd=value;
      expect(resolve(input).clusters[MAINNET].fees.maxFeeUsd).toBe(value);
    });
    it.each(['2.000001','2.01','3'])('maxFeeUsd %s rejected '+(enabled?'enabled':'dormant'),value=>{
      const resolve=requireFn(configModule,'resolveSolanaConfig');const input=template(enabled);input.clusters[MAINNET].fees.maxFeeUsd=value;
      expect(()=>resolve(input)).toThrow(/SOL_DENY_CONFIG_ABOVE_CEILING/);
    });
  }
  it('absent maxFeeUsd stays undefined and fails readiness',()=>{
    const resolve=requireFn(configModule,'resolveSolanaConfig');const ready=requireFn(configModule,'assertSolanaClusterReady');const input=template();delete input.clusters[MAINNET].fees.maxFeeUsd;
    const resolved=resolve(input);expect(resolved.clusters[MAINNET].fees.maxFeeUsd).toBeUndefined();expect(()=>ready(resolved,MAINNET)).toThrow(/maxFeeUsd/);
  });
  for(const [path] of ceilings)it(`absent ${path} stays undefined and fails readiness`,()=>{
    const resolve=requireFn(configModule,'resolveSolanaConfig');const ready=requireFn(configModule,'assertSolanaClusterReady');const input=template();const p=parent(input.clusters[MAINNET],path);delete p.object[p.name];
    const resolved=resolve(input);const r=parent(resolved.clusters[MAINNET],path);expect(r.object[r.name]).toBeUndefined();expect(()=>ready(resolved,MAINNET)).toThrow();
  });
  it('maxPerTxUsd has no default and is required at readiness',()=>{
    const resolve=requireFn(configModule,'resolveSolanaConfig');const ready=requireFn(configModule,'assertSolanaClusterReady');const resolved=resolve(template());delete resolved.clusters[MAINNET].maxPerTxUsd;
    // PR2 already rejects an incomplete policy-bearing input at resolve; mutate resolved config to isolate readiness.
    expect(()=>ready(resolved,MAINNET)).toThrow(/maxPerTxUsd/);
  });
  it.each(['native',WSOL,USDC,USDT])('missing cap %s fails readiness',asset=>{
    const resolve=requireFn(configModule,'resolveSolanaConfig');const ready=requireFn(configModule,'assertSolanaClusterReady');const input=template();delete input.clusters[MAINNET].tokenCaps[asset];
    const resolved=resolve(input);expect(resolved.clusters[MAINNET].tokenCaps[asset]).toBeUndefined();expect(()=>ready(resolved,MAINNET)).toThrow();
  });
  it.each(['native',WSOL,USDC,USDT])('zero cap %s is preserved by resolve and readiness',asset=>{
    const resolve=requireFn(configModule,'resolveSolanaConfig');const input=template();input.clusters[MAINNET].tokenCaps[asset]='0';
    const resolved=resolve(input);expect(resolved.clusters[MAINNET].tokenCaps[asset]).toBe('0');expect(()=>requireFn(configModule,'assertSolanaClusterReady')(resolved,MAINNET)).not.toThrow();
  });
  it.each(['native-zero-cap','token-zero-cap'])('%s closes positive policy debits',async id=>{
    const check=requireFn(mod,'assertSolanaActionsAllowed');const v=policyVectors.find(v=>v.id===id)!;assertIntent(v.intent);
    const context=await policyContext(undefined,v.configProfile);expectDeny(()=>check(decode(Buffer.from(v.messageHex,'hex')),context,v.intent),'SOL_DENY_TOKEN_CAP');
  });
});
