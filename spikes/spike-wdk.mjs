// Block 0 spike — TRACK WDK
// Proves self-custodial wallet creation, HD account derivation, and a LIVE
// balance read against the Sepolia testnet RPC through WDK.
//
//   node spikes/spike-wdk.mjs                 -> random seed, derive + read balances
//   SEED="word1 ... word12" node spikes/spike-wdk.mjs  -> use a funded dev wallet
//   USDT=0x... node spikes/spike-wdk.mjs      -> also query a test-USDT token balance
//
// The write path (transfer) needs faucet funds; this spike proves the read path
// end-to-end and derives a stable address you can fund once via the faucet.

import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { SeedSignerEvm } from '@tetherto/wdk-wallet-evm/signers'

const RPC = process.env.RPC || 'https://sepolia.drpc.org' // Sepolia (chainId 11155111)

async function main () {
  console.log('[spike-wdk] WDK self-custodial wallet test (Sepolia testnet)')

  const seed = process.env.SEED || WDK.getRandomSeedPhrase()
  console.log('seed valid?', WDK.isValidSeed(seed))
  if (!process.env.SEED) {
    console.log('generated dev seed (fund this to test transfers):\n  ', seed)
  }

  const root = new SeedSignerEvm(seed)
  const wallet = new WalletManagerEvm(root, {
    provider: RPC,
    transferMaxFee: 100000000000000n // 0.0001 ETH cap
  })

  // HD derivation — two accounts from one seed proves BIP-44 pathing
  const acct0 = await wallet.getAccount(0)
  const acct1 = await wallet.getAccount(1)
  const addr0 = await acct0.getAddress()
  const addr1 = await acct1.getAddress()
  console.log('account[0] address:', addr0)
  console.log('account[1] address:', addr1)

  // Live read against Sepolia RPC
  const nativeWei = await acct0.getBalance()
  console.log('account[0] native balance (wei):', nativeWei.toString())
  console.log('account[0] native balance (ETH):', Number(nativeWei) / 1e18)

  if (process.env.USDT) {
    const bal = await acct0.getTokenBalance(process.env.USDT)
    console.log(`account[0] USDT (${process.env.USDT}) balance:`, bal.toString())
  }

  wallet.dispose?.()
  console.log('\n✅ PASS — WDK created a self-custodial wallet, derived HD accounts, and read live Sepolia balances.')
  console.log('   Next: fund account[0] with test ETH + mock USD₮ from the Candide faucet to demo a real transfer.')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n❌ FAIL —', e?.stack || e?.message || e)
  process.exit(1)
})
