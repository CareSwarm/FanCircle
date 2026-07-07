// Self-custodial USDT tipping via WDK. Each user holds their own BIP-39
// seed (no custodian). Tips are real ERC-20 transfers; tx hash links to
// Etherscan.
//
// Seed lives in a gitignored file under .wallet/ — fine for a demo wallet,
// swap for OS keychain / encrypted storage before this touches real funds.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { SeedSignerEvm } from '@tetherto/wdk-wallet-evm/signers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Per-instance wallet dir (so two demo users on one machine hold distinct seeds).
const WALLET_DIR = process.env.WALLET_DIR
  ? path.resolve(process.env.WALLET_DIR)
  : path.join(__dirname, '..', '.wallet')
const SEED_FILE = path.join(WALLET_DIR, 'seed.txt')

const LOCAL = process.env.FANCIRCLE_CHAIN === 'local' ||
  /127\.0\.0\.1|localhost/.test(process.env.RPC || '')

// Local mode reads the freshly-deployed mock-USDT address from a file if env is unset.
function localUsdt () {
  if (process.env.FANCIRCLE_USDT) return process.env.FANCIRCLE_USDT
  try { return fs.readFileSync(path.join(__dirname, '..', '.wallet', 'local-usdt.txt'), 'utf8').trim() } catch { return null }
}

export const CHAIN = LOCAL
  ? {
      name: 'Local devnet',
      chainId: 31337,
      rpc: process.env.RPC || 'http://127.0.0.1:8545',
      explorer: null, // no public explorer on a local chain
      usdt: localUsdt(),
      usdtDecimals: 6
    }
  : {
      name: 'Sepolia',
      chainId: 11155111,
      rpc: process.env.RPC || 'https://sepolia.drpc.org',
      explorer: 'https://sepolia.etherscan.io',
      // Mock USD₮ on Sepolia. Set FANCIRCLE_USDT once minted from the Candide/Pimlico faucet.
      usdt: process.env.FANCIRCLE_USDT || null,
      usdtDecimals: 6
    }

export class Wallet {
  constructor () {
    this.seed = this._loadOrCreateSeed()
    this.manager = new WalletManagerEvm(new SeedSignerEvm(this.seed), {
      provider: CHAIN.rpc,
      // Safety cap on gas cost per tip. Generous for testnet/local; override with FANCIRCLE_MAX_FEE (wei).
      transferMaxFee: BigInt(process.env.FANCIRCLE_MAX_FEE || 20000000000000000n) // 0.02 ETH default
    })
    this.account = null
  }

  _loadOrCreateSeed () {
    if (fs.existsSync(SEED_FILE)) return fs.readFileSync(SEED_FILE, 'utf8').trim()
    fs.mkdirSync(WALLET_DIR, { recursive: true })
    const seed = WDK.getRandomSeedPhrase()
    fs.writeFileSync(SEED_FILE, seed, { mode: 0o600 })
    return seed
  }

  async init () {
    this.account = await this.manager.getAccount(0)
    this.address = await this.account.getAddress()
    return this.address
  }

  async balances () {
    const native = await this.account.getBalance()
    let usdt = null
    if (CHAIN.usdt) {
      try { usdt = (await this.account.getTokenBalance(CHAIN.usdt)).toString() } catch { usdt = null }
    }
    return {
      address: this.address,
      nativeWei: native.toString(),
      nativeEth: Number(native) / 1e18,
      usdtBase: usdt,
      usdt: usdt != null ? Number(usdt) / 10 ** CHAIN.usdtDecimals : null
    }
  }

  // amount is a human number of USDT (e.g. 1 => 1 USD₮)
  async tip (recipient, amount) {
    if (!CHAIN.usdt) throw new Error('USDT contract not configured (set FANCIRCLE_USDT)')
    const base = BigInt(Math.round(amount * 10 ** CHAIN.usdtDecimals))
    const quote = await this.account.quoteTransfer({ token: CHAIN.usdt, recipient, amount: base })
    const res = await this.account.transfer({ token: CHAIN.usdt, recipient, amount: base })
    return {
      hash: res.hash,
      fee: res.fee?.toString?.() ?? String(res.fee),
      explorer: CHAIN.explorer ? `${CHAIN.explorer}/tx/${res.hash}` : null,
      quotedFee: quote?.fee?.toString?.() ?? null
    }
  }

  dispose () { try { this.manager.dispose?.() } catch {} }
}
