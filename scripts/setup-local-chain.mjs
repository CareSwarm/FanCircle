// Zero-faucet local tipping demo. Requires anvil running (`anvil` in another terminal)
// and foundry (forge/cast) installed. Deploys a mock USD₮, funds both demo wallets
// with ETH + USD₮, and writes the token address so the app picks it up automatically.
//
//   anvil                        # terminal A
//   npm run chain:setup          # terminal B (this script)
//   FANCIRCLE_CHAIN=local npm run demo:minh   # terminal C
//   FANCIRCLE_CHAIN=local npm run demo:alex   # terminal D
//
// Anvil's first account (well-known dev key) is the deployer/funder.

import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const RPC = process.env.RPC || 'http://127.0.0.1:8545'
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil acct[0]

const cast = (args) => execFileSync('cast', args, { encoding: 'utf8' }).trim()

function walletAddress (dir) {
  const r = spawnSync(process.execPath, ['-e', `
    import('${path.join(root, 'src/wallet.mjs').replace(/\\\\/g, '/')}').then(async ({ Wallet }) => {
      const w = new Wallet(); console.log(await w.init()); w.dispose()
    })`], { env: { ...process.env, WALLET_DIR: dir, FANCIRCLE_CHAIN: 'local' }, cwd: root, encoding: 'utf8' })
  return (r.stdout || '').trim().split('\n').pop()
}

function main () {
  // 0) anvil reachable?
  try { cast(['block-number', '--rpc-url', RPC]) } catch {
    console.error(`\n❌ Cannot reach anvil at ${RPC}. Start it first:  anvil\n`); process.exit(1)
  }

  // 1) deploy mock USD₮
  console.log('Deploying mock USD₮ …')
  const out = execFileSync('forge', ['create', 'src/MockUSDT.sol:MockUSDT', '--rpc-url', RPC, '--private-key', DEPLOYER_PK, '--broadcast'],
    { cwd: path.join(root, 'chain'), encoding: 'utf8' })
  const usdt = (out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/) || [])[1]
  if (!usdt) { console.error('deploy failed:\n' + out); process.exit(1) }
  console.log('  USD₮:', usdt)

  // 2) fund each demo wallet with ETH (gas) + 1000 USD₮
  const wallets = [
    { name: 'Minh', dir: '.wallet/minh' },
    { name: 'Alex', dir: '.wallet/alex' }
  ]
  for (const w of wallets) {
    const addr = walletAddress(w.dir)
    cast(['send', addr, '--value', '5ether', '--rpc-url', RPC, '--private-key', DEPLOYER_PK])
    cast(['send', usdt, 'mint(address,uint256)', addr, '1000000000', '--rpc-url', RPC, '--private-key', DEPLOYER_PK])
    console.log(`  funded ${w.name} ${addr}  → 5 ETH + 1000 USD₮`)
  }

  // 3) persist token address for the app
  fs.mkdirSync(path.join(root, '.wallet'), { recursive: true })
  fs.writeFileSync(path.join(root, '.wallet', 'local-usdt.txt'), usdt)

  console.log('\n✅ Local chain ready. Now run the two fans with local mode:')
  console.log('   FANCIRCLE_CHAIN=local npm run demo:minh')
  console.log('   FANCIRCLE_CHAIN=local npm run demo:alex')
  console.log('   → tips are real on-chain transfers, no faucet needed.\n')
}

main()
