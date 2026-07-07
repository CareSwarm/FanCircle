// Verifies the WDK tip() path end-to-end against a real EVM chain.
// Run with a chain configured via env (local anvil or Sepolia):
//   RPC=http://127.0.0.1:8545 FANCIRCLE_USDT=0x... WALLET_DIR=.wallet/minh \
//     RECIPIENT=0xAlex... node spikes/spike-tip.mjs

import { Wallet, CHAIN } from '../src/wallet.mjs'

async function main () {
  const recipient = process.env.RECIPIENT
  if (!recipient) throw new Error('set RECIPIENT=0x...')
  if (!CHAIN.usdt) throw new Error('set FANCIRCLE_USDT=0x...')

  const w = new Wallet()
  await w.init()
  console.log('sender     :', w.address)
  console.log('recipient  :', recipient)
  console.log('chain      :', CHAIN.name, CHAIN.rpc)
  console.log('usdt       :', CHAIN.usdt)

  const before = await w.balances()
  console.log('\nsender USD₮ before:', before.usdt)

  console.log('sending 5 USD₮ tip…')
  const r = await w.tip(recipient, 5)
  console.log('  tx hash :', r.hash)
  console.log('  fee     :', r.fee)
  console.log('  explorer:', r.explorer)

  const after = await w.balances()
  console.log('\nsender USD₮ after :', after.usdt)

  const spent = before.usdt - after.usdt
  const ok = Math.abs(spent - 5) < 1e-6 && !!r.hash
  console.log(ok ? '\n✅ PASS — WDK sent a real on-chain USD₮ transfer (sender debited 5).' : '\n❌ FAIL — balance change unexpected: ' + spent)
  w.dispose()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('\n❌ FAIL —', e?.stack || e?.message || e); process.exit(1) })
