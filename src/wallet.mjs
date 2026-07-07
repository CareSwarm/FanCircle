// TRACK WDK — self-custodial USDT tipping through the Wallet Development Kit.
// Each user holds their own BIP-39 seed (no custodian). Tips are real ERC-20
// transfers on the Sepolia testnet; the tx hash is shown and links to Etherscan.
//
// Security note (hackathon MVP): the seed is stored in a gitignored file under
// .wallet/. Block 3 upgrades this to OS keychain / encrypted-at-rest per WDK docs.

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

export const CHAIN = {
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
      transferMaxFee: 100000000000000n // 0.0001 ETH safety cap
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
      explorer: `${CHAIN.explorer}/tx/${res.hash}`,
      quotedFee: quote?.fee?.toString?.() ?? null
    }
  }

  dispose () { try { this.manager.dispose?.() } catch {} }
}
