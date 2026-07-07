// Prints the demo wallet addresses so you know what to fund from the faucet.
//   node scripts/wallet-info.mjs
// Wallets are created lazily on first run; this creates them if missing.

import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const users = [
  { name: 'Minh (8080)', dir: '.wallet/minh' },
  { name: 'Alex (8081)', dir: '.wallet/alex' }
]

console.log('\nFanCircle demo wallets (Sepolia testnet)\n' + '='.repeat(42))
for (const u of users) {
  const r = spawnSync(process.execPath, ['-e', `
    import('${path.join(root, 'src/wallet.mjs').replace(/\\/g, '/')}').then(async ({ Wallet }) => {
      const w = new Wallet(); const a = await w.init(); console.log(a); w.dispose()
    })
  `], { env: { ...process.env, WALLET_DIR: u.dir }, cwd: root, encoding: 'utf8' })
  const addr = (r.stdout || '').trim().split('\n').pop()
  console.log(`${u.name.padEnd(14)} ${addr || '(error: ' + (r.stderr || '').trim() + ')'}`)
}
console.log('\nFund each with test ETH (gas) + mock USD₮, then run with FANCIRCLE_USDT set.')
console.log('Faucets: https://dashboard.candide.dev/faucet  ·  https://sepolia-faucet.pk910.de\n')
