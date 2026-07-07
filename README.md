# 🏟️ FanCircle

**A peer-to-peer, multilingual World Cup watch-party — no servers, no accounts, on-device AI translation, and self-custodial USDT tipping.**

Football is the most global thing on earth, but the way we watch it together online is not. Group chats are centralized and blocked in football-mad countries; nobody translates cross-language banter in real time; and there is no honest way to send your friend — or a great fan commentator halfway across the world — a few dollars. FanCircle fixes all three, and it does it during the one moment 6 billion people care: **the 2026 World Cup, whose final is July 19.**

Built for the **Tether Developers Cup**, entering all three tracks:

| Track | What FanCircle uses it for |
|-------|----------------------------|
| **Pears** (Holepunch / Hyperswarm) | Fully peer-to-peer match rooms — chat, reactions, and prediction polls travel directly between fans over the Hyperswarm DHT. No application server. Room history and poll tallies are backed by an **Autobase** replicated log, so a fan who joins mid-match still gets full history and a correct tally — not just gossip from the moment they connected. |
| **QVAC** (on-device AI) | Every chat message is translated **on your own device** into each fan's language through the QVAC SDK (Bergamot NMT) — Vietnamese ↔ English ↔ Spanish ↔ Arabic ↔ … Voice notes are transcribed on-device (Whisper) and translated the same way. A grounded on-device LLM answers football questions (`/ask`), in every fan's language. No cloud AI — speech, translation, and completion all run locally. |
| **WDK** (Wallet Development Kit) | Self-custodial USD₮ tipping to room hosts / fan commentators. Each fan holds their own seed; tips are real on-chain transfers (Sepolia testnet). |

> **The theme is the filter, the stack is the point.** FanCircle is a watch-party app, but its reason to exist is that it genuinely needs all three parts of the Tether stack — P2P for censorship-resistant rooms, on-device AI so a fan on a weak network in a developing country can still cross the language barrier, and self-custodial money so value flows fan-to-fan without a platform in the middle.

---

## Quick start (judges: run it in ~2 minutes)

**Prerequisites:** [Node.js](https://nodejs.org) **≥ 22.17** (`node -v` to check). macOS / Linux / Windows. [ffmpeg](https://ffmpeg.org) is optional — only needed for voice notes; everything else works without it.

```bash
git clone <this-repo>
cd FanCircle
npm install
```

Open **two terminals** to play two fans on one machine:

```bash
# Terminal 1 — a Vietnamese fan
npm run demo:minh      # → http://localhost:8080

# Terminal 2 — an English fan
npm run demo:alex      # → http://localhost:8081
```

Now open **http://localhost:8080** and **http://localhost:8081** in two browser windows:

1. On **8080 (Minh)** click **＋ Create room**, then **copy** the room link.
2. On **8081 (Alex)** paste it into **paste room link** and click **Join**. Within a few seconds both show **2 fans in room**.
3. Type a message on either side **in your own language**. The other fan sees it translated live, on-device (🌐).
4. Click **＋ New poll** to run a prediction poll; both fans vote and tallies sync peer-to-peer.
5. Type **`/ask offside rule?`** (or any football question) — a small LLM answers **on your device**, and the answer is shared to the room in everyone's language.
6. Click **🎙️** to record a short voice note. It's transcribed **on your device** (Whisper), sent to the room, and each fan sees it translated into their own language, with the original audio playable. *(Needs [ffmpeg](https://ffmpeg.org) installed — `brew install ffmpeg` / `apt install ffmpeg`; the backend logs whether it found it on boot.)*
7. Click **💸 tip** next to a fan to send USD₮ *(needs one-time setup — see below)*.

> **First translation downloads a model.** The first time a language pair is used, QVAC fetches a small (~20–35 MB) Bergamot model and caches it. Subsequent translations are instant and fully offline. Try it: **turn off your Wi-Fi and keep chatting — translation still works.** That is the whole point of on-device AI.

Two machines on different networks work exactly the same way — share the room link over any channel; the Hyperswarm DHT connects them directly.

---

## How each track is used (for judges)

### Pears — `src/p2p.mjs` (gossip) + `src/roomlog.mjs` (durable history)
A room is a 32-byte topic. Peers `swarm.join(topic)` and connect directly over the **Hyperswarm DHT** with end-to-end-encrypted (Noise) streams — the exact pattern from the official *"Making a Pear Desktop Application"* guide. Chat, reactions, poll creation and votes are newline-delimited JSON gossiped to every connected peer for instant delivery. There is **no application server**: the localhost HTTP/WebSocket in this build is only how the local browser UI talks to the local process (like Electron IPC); **all fan-to-fan traffic is Hyperswarm.**

On top of that, the room creator runs an **Autobase** — a Holepunch multiwriter append-log — and every peer replicates it over its own Hyperswarm swarm (Corestore replication is a separate protocol from the raw gossip, so it gets its own connections). Chat, votes, voice notes, assistant answers and tips are durably appended; when a fan joins mid-match, their backend replays that log — full chat history and a correct, authoritative poll tally, translated on-device into their language — not just whatever gossip happens to arrive after they connect. Reactions are intentionally left out of the durable log (nobody wants 50 old 🔥 replaying on join). Multi-writer (peers appending directly, granted via Autobase's `addWriter`) is proven in `spikes/spike-autobase.mjs` and is a natural upgrade from this single-writer-per-room MVP.

*Verify it:* `npm run spike:p2p` spins up two swarms that find each other over the live DHT and exchange messages. `node spikes/spike-autobase.mjs` proves multi-writer convergence + late-join replication in isolation; `node spikes/spike-lateJoiner.mjs` (with three backends running) proves it through the real app — a third fan joining after messages and votes already happened gets full backfill and a correct tally.

### QVAC — `src/ai.mjs` (translation) + `src/assistant.mjs` (match assistant)
Translation runs **entirely on-device through the QVAC SDK** (`@qvac/sdk`), using Bergamot NMT models loaded from QVAC's registry. Each user sets their language; any incoming message in another language is translated locally before display. Pairs with no direct model pivot through English automatically.

The **match assistant** (`/ask …`) is a small grounded LLM (Qwen3-0.6B) run through QVAC `completion()`, answering rules/stats questions on-device. A fan's question is translated to English, answered locally, then the answer is shared to the room and translated back into each fan's own language — a fully multilingual, fully offline loop.

**Voice notes** (`src/voice.mjs`): the browser records with `MediaRecorder`; the sender's backend decodes the clip (ffmpeg — a local, offline container conversion, not an AI call) and transcribes it **on-device** with QVAC's multilingual Whisper (`WHISPER_BASE_Q8_0`). The transcript is broadcast over the room (Pears); each peer translates it on *their own* device before display, and the original audio is included so peers can also hear the real voice. No cloud AI API is ever called anywhere in this chain — required by the QVAC track, and the reason all of it keeps working with the network off.

*Verify it:* `npm run spike:qvac` translates English↔Vietnamese on-device (~250 ms/sentence cached); `node spikes/spike-llm.mjs` runs the grounded assistant; `node spikes/spike-voice.mjs <audio-file> [lang]` runs on-device transcription.

### WDK — `src/wallet.mjs`
Each fan gets a **self-custodial** BIP-39 wallet via `@tetherto/wdk` + `@tetherto/wdk-wallet-evm` (no custodian; the seed never leaves the machine). Tips are real ERC-20 USD₮ `transfer()`s on the **Sepolia** testnet; the returned tx hash links to Etherscan so anyone can verify the transfer on-chain.

*Verify it:* `npm run spike:wdk` creates a wallet, derives HD accounts, and reads live Sepolia balances.

---

## Enabling USD₮ tipping

The chat + translation demo above needs no blockchain. To also demo **tipping**, pick one path:

### Option A — Local chain, zero faucet (fastest for judges)

Requires [Foundry](https://getfoundry.sh) (`anvil`, `forge`). Three terminals:

```bash
anvil                                       # terminal A: local EVM
npm run chain:setup                         # terminal B: deploy mock USD₮, fund both wallets
FANCIRCLE_CHAIN=local npm run demo:minh     # terminal C
FANCIRCLE_CHAIN=local npm run demo:alex     # terminal D
```

Both wallets start with 1000 USD₮; the **💸 tip** button now sends a real transfer on the local chain (verify the sender's balance drops). No faucet, no accounts.

### Option B — Sepolia public testnet (real, Etherscan-verifiable)

Tipping needs a funded wallet and the test-USD₮ contract address. Print your two demo wallet addresses:

```bash
node scripts/wallet-info.mjs
```

Then, for each address:

1. **Get test ETH (gas)** from a Sepolia faucet (e.g. [sepolia-faucet.pk910.de](https://sepolia-faucet.pk910.de) or [Google Cloud Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)).
2. **Get mock USD₮** from the [Candide test-ERC20 faucet](https://dashboard.candide.dev/faucet) or [Pimlico test-ERC20 faucet](https://dashboard.pimlico.io/test-erc20-faucet). Note the token's contract address.
3. Start the app with that contract address set:

```bash
FANCIRCLE_USDT=0xYourTestUsdtContract npm run demo:minh
FANCIRCLE_USDT=0xYourTestUsdtContract npm run demo:alex
```

Now the wallet shows a USD₮ balance and the **💸 tip** button sends a real on-chain transfer. *(Gasless "pay fees in USD₮" via the WDK ERC-4337 / 7702 modules is on the roadmap below.)*

---

## Architecture

```
Browser UI (app/)  ──WebSocket──►  Node backend (src/backend.mjs)  ──►  Room  (Pears / Hyperswarm)  ──DHT──►  other fans
   one per fan                     one process = one fan            ├──►  AI    (QVAC / on-device translate)
                                                                    └──►  Wallet (WDK / USD₮ on Sepolia)
```

The P2P layer (`src/p2p.mjs`) is deliberately isolated so it can be lifted into a **Bare worklet** for native Pear-app packaging (`pear://` distribution, P2P OTA updates) — see roadmap.

---

## Third-party services (disclosure per hackathon rules)

- **QVAC model registry** — Bergamot translation models are fetched on first use from QVAC's registry, then cached and run **locally**. Inference is 100% on-device; no cloud AI.
- **Ethereum RPC** — `https://sepolia.drpc.org` (public Sepolia RPC) for wallet balance reads and broadcasting tip transactions. Blockchain infrastructure, not an AI service.
- **Testnet faucets** — Candide / Pimlico (mock USD₮) and a public Sepolia ETH faucet, used only to fund demo wallets.

No pre-existing project code was reused; the codebase was built during the hackathon. Open-source dependencies are listed in `package.json`.

---

## Roadmap (post first-cut hardening)

- **Multi-writer rooms** — let any fan (not just the creator) durably append via Autobase's `addWriter`, already proven in `spikes/spike-autobase.mjs`.
- **Assistant RAG** — upgrade the match assistant to QVAC's full RAG pipeline over live match data + a higher-quality LLM translation fallback for idioms/slang.
- **Gasless USD₮ tipping** — WDK ERC-4337 / EIP-7702 modules so fans pay fees in USD₮, no ETH needed.
- **Native Pear app** — package the P2P core into a Bare worklet + Electron shell, distributed via `pear://` with peer-to-peer updates.

## Running multiple fans on one machine (for testing)

Each backend is one fan (`npm run demo:minh`, `demo:alex`, or `PORT=... NAME=... LANG_CODE=... WALLET_DIR=... node src/backend.mjs` for more). This works great for local testing, with one caveat: QVAC's model cache/registry (`~/.qvac`) is shared machine-wide, and each backend spawns its own `bare` inference worker — running several at once can occasionally hit a transient "file descriptor could not be locked" the first time two backends need the registry at the same instant. `src/ai.mjs`/`src/assistant.mjs` retry automatically, so it self-heals within a couple seconds. This never happens in real use: each fan is on their own device with their own cache.

---

## License

[Apache-2.0](LICENSE). Public for the duration of the Tether Developers Cup and a reasonable period after.
