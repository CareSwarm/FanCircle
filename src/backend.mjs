// FanCircle backend — one process = one user. Orchestrates the three tracks:
//   Pears (Room / Hyperswarm) · QVAC (AI / translation) · WDK (Wallet / tipping)
// Serves the local web UI (app/) and bridges it to the P2P room over WebSocket.
// The localhost HTTP/WS is UI<->backend IPC only; peer<->peer traffic is 100% Hyperswarm.

import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { Room } from './p2p.mjs'
import { AI } from './ai.mjs'
import { Assistant } from './assistant.mjs'
import { Wallet, CHAIN } from './wallet.mjs'
import { base64ToWav, cleanup as cleanupWav, hasFfmpeg } from './voice.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.join(__dirname, '..', 'app')
const PORT = Number(process.env.PORT || 8080)

const SUPPORTED_LANGS = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'ar', label: 'العربية' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' }
]

const ai = new AI()
const assistant = new Assistant()
const wallet = new Wallet()
const state = {
  profile: { name: process.env.NAME || 'Fan-' + crypto.randomBytes(2).toString('hex'), lang: process.env.LANG_CODE || 'en' },
  room: null,
  polls: new Map() // pollId -> { id, question, options:[], votes: Map(voterId->idx), creator }
}

const uiClients = new Set()
function pushUI (obj) {
  const s = JSON.stringify(obj)
  for (const ws of uiClients) { try { ws.send(s) } catch {} }
}

// ---------- static file server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0]
  if (url === '/') url = '/index.html'
  const file = path.join(APP_DIR, path.normalize(url).replace(/^(\.\.[\/\\])+/, ''))
  if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

// ---------- room wiring ----------
function wireRoom (room) {
  room.on('peer-join', ({ id, profile }) => {
    pushUI({ t: 'members', list: room.memberList() })
    pushUI({ t: 'system', text: `${profile.name} joined` })
    ai.warmup(room.memberList().map((m) => m.profile.lang), state.profile.lang)
  })
  room.on('peer-leave', ({ profile }) => {
    pushUI({ t: 'members', list: room.memberList() })
    pushUI({ t: 'system', text: `${profile?.name || 'someone'} left` })
  })
  room.on('message', (msg) => onPeerMessage(msg))
}

async function onPeerMessage (msg) {
  switch (msg.type) {
    case 'chat': {
      let translated = null
      if (msg.lang && msg.lang !== state.profile.lang) {
        try { translated = await ai.translate(msg.text, msg.lang, state.profile.lang) } catch (e) { translated = null }
      }
      pushUI({ t: 'chat', id: msg.id, from: msg.from, name: msg.name, lang: msg.lang, text: msg.text, translated, ts: msg.ts, self: false })
      break
    }
    case 'reaction':
      pushUI({ t: 'reaction', from: msg.from, name: msg.name, emoji: msg.emoji })
      break
    case 'poll-create':
      state.polls.set(msg.poll.id, { ...msg.poll, votes: new Map() })
      pushPolls()
      break
    case 'poll-vote':
      recordVote(msg.pollId, msg.voter, msg.optionIndex)
      break
    case 'assistant':
      await deliverAssistant(msg)
      break
    case 'voice':
      await deliverVoice(msg)
      break
    case 'tip':
      pushUI({ t: 'tip', from: msg.from, name: msg.name, amount: msg.amount, hash: msg.hash, explorer: msg.explorer, to: msg.to })
      break
  }
}

// The on-device match assistant answers in English; each peer translates the answer locally.
async function deliverAssistant (msg) {
  let translated = null
  if (msg.lang && msg.lang !== state.profile.lang) {
    try { translated = await ai.translate(msg.text, msg.lang, state.profile.lang) } catch { translated = null }
  }
  pushUI({ t: 'assistant', from: msg.from, name: msg.name, question: msg.question, answer: msg.text, translated, ts: msg.ts })
}

// The sender transcribes on their own device (that's where the mic audio is);
// each peer translates the transcript on their own device before display.
async function deliverVoice (msg) {
  let translated = null
  if (msg.lang && msg.lang !== state.profile.lang) {
    try { translated = await ai.translate(msg.text, msg.lang, state.profile.lang) } catch { translated = null }
  }
  pushUI({ t: 'voice', id: msg.id, from: msg.from, name: msg.name, lang: msg.lang, text: msg.text, translated, audio: msg.audio, mime: msg.mime, ts: msg.ts, self: msg.from === state.room?.me })
}

async function handleVoice (ws, m) {
  if (!state.room) return
  if (!(await hasFfmpeg())) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'ffmpeg not found — required to decode voice notes (see README).' }))
  const audio = String(m.audio || '')
  if (!audio) return
  pushUI({ t: 'voice-pending', name: state.profile.name })
  let wavPath
  try {
    wavPath = await base64ToWav(audio, 'webm')
    const text = await ai.transcribe(wavPath, state.profile.lang)
    if (!text) { pushUI({ t: 'voice-pending-clear' }); return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: "Couldn't hear anything in that clip." })) }
    const msg = { type: 'voice', id: crypto.randomBytes(6).toString('hex'), from: state.room.me, name: state.profile.name, lang: state.profile.lang, text, audio, mime: m.mime || 'audio/webm', ts: Date.now() }
    state.room.broadcast(msg)
    await deliverVoice(msg)
  } catch (e) {
    pushUI({ t: 'voice-pending-clear' })
    pushUI({ t: 'toast', level: 'error', text: 'Voice note failed: ' + (e?.message || e) })
  } finally {
    await cleanupWav(wavPath)
  }
}

async function handleAsk (question) {
  if (!state.room) return
  pushUI({ t: 'assistant-pending', name: state.profile.name, question })
  // Ground the small English model: translate the question to English if needed.
  let qEn = question
  try { if (state.profile.lang !== 'en') qEn = await ai.translate(question, state.profile.lang, 'en') } catch {}
  let answer
  try {
    answer = await assistant.ask(qEn, (p) => {
      const pct = Math.floor((p?.progress ?? p ?? 0) * 100)
      if (pct % 25 === 0) pushUI({ t: 'toast', level: 'info', text: `Loading match assistant… ${pct}%` })
    })
  } catch (e) {
    pushUI({ t: 'toast', level: 'error', text: 'Assistant failed: ' + (e?.message || e) })
    return
  }
  const msg = { type: 'assistant', id: crypto.randomBytes(6).toString('hex'), from: state.room.me, name: state.profile.name, question, lang: 'en', text: answer, ts: Date.now() }
  state.room.broadcast(msg)
  await deliverAssistant(msg)
}

function recordVote (pollId, voter, optionIndex) {
  const poll = state.polls.get(pollId)
  if (!poll) return
  poll.votes.set(voter, optionIndex) // last vote wins, one vote per voter
  pushPolls()
}

function pollView (poll) {
  const tally = poll.options.map(() => 0)
  for (const idx of poll.votes.values()) if (tally[idx] != null) tally[idx]++
  return { id: poll.id, question: poll.question, options: poll.options, tally, total: poll.votes.size }
}
function pushPolls () {
  pushUI({ t: 'polls', polls: [...state.polls.values()].map(pollView) })
}

// ---------- UI command handlers ----------
async function handleUI (ws, m) {
  switch (m.t) {
    case 'init':
      ws.send(JSON.stringify({
        t: 'ready',
        me: state.room?.me || null,
        profile: state.profile,
        langs: SUPPORTED_LANGS,
        chain: { name: CHAIN.name, explorer: CHAIN.explorer, usdtConfigured: !!CHAIN.usdt },
        address: wallet.address,
        room: state.room ? { topic: state.room.topicHex } : null
      }))
      ws.send(JSON.stringify({ t: 'balances', balances: await safeBalances() }))
      if (state.room) { ws.send(JSON.stringify({ t: 'members', list: state.room.memberList() })); pushPolls() }
      break

    case 'set-profile':
      if (m.name) state.profile.name = String(m.name).slice(0, 24)
      if (m.lang) state.profile.lang = m.lang
      if (state.room) state.room.profile = state.profile
      pushUI({ t: 'profile', profile: state.profile })
      break

    case 'create-room': {
      await leaveRoom()
      state.room = new Room({ profile: state.profile })
      wireRoom(state.room)
      const topic = await state.room.join()
      pushUI({ t: 'room', topic })
      pushUI({ t: 'members', list: state.room.memberList() })
      break
    }

    case 'join-room': {
      const topic = String(m.topic || '').trim()
      if (!/^[0-9a-fA-F]{64}$/.test(topic)) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'Invalid room link' }))
      await leaveRoom()
      state.room = new Room({ topic, profile: state.profile })
      wireRoom(state.room)
      await state.room.join()
      pushUI({ t: 'room', topic })
      pushUI({ t: 'members', list: state.room.memberList() })
      break
    }

    case 'chat': {
      if (!state.room) return
      const text = String(m.text).slice(0, 2000)
      if (/^\/ask\s+/i.test(text.trim())) { await handleAsk(text.trim().replace(/^\/ask\s+/i, '')); break }
      const msg = { type: 'chat', id: crypto.randomBytes(6).toString('hex'), from: state.room.me, name: state.profile.name, lang: state.profile.lang, text, ts: Date.now() }
      state.room.broadcast(msg)
      pushUI({ t: 'chat', id: msg.id, from: msg.from, name: msg.name, lang: msg.lang, text: msg.text, translated: null, ts: msg.ts, self: true })
      break
    }

    case 'reaction': {
      if (!state.room) return
      const msg = { type: 'reaction', from: state.room.me, name: state.profile.name, emoji: String(m.emoji).slice(0, 8) }
      state.room.broadcast(msg)
      pushUI({ t: 'reaction', from: msg.from, name: msg.name, emoji: msg.emoji })
      break
    }

    case 'poll-create': {
      if (!state.room) return
      const poll = { id: crypto.randomBytes(6).toString('hex'), question: String(m.question).slice(0, 140), options: (m.options || []).slice(0, 4).map((o) => String(o).slice(0, 60)), creator: state.room.me }
      if (poll.options.length < 2) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'Poll needs 2+ options' }))
      state.polls.set(poll.id, { ...poll, votes: new Map() })
      state.room.broadcast({ type: 'poll-create', poll })
      pushPolls()
      break
    }

    case 'poll-vote': {
      if (!state.room) return
      recordVote(m.pollId, state.room.me, m.optionIndex)
      state.room.broadcast({ type: 'poll-vote', pollId: m.pollId, voter: state.room.me, optionIndex: m.optionIndex })
      break
    }

    case 'voice': {
      await handleVoice(ws, m)
      break
    }

    case 'tip': {
      await handleTip(ws, m)
      break
    }

    case 'refresh-balance':
      ws.send(JSON.stringify({ t: 'balances', balances: await safeBalances() }))
      break
  }
}

async function handleTip (ws, m) {
  const recipient = String(m.recipient || '').trim()
  const amount = Number(m.amount)
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'Bad recipient address' }))
  if (!(amount > 0)) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'Bad amount' }))
  if (!CHAIN.usdt) return ws.send(JSON.stringify({ t: 'toast', level: 'error', text: 'USDT contract not set — configure FANCIRCLE_USDT (see README).' }))
  pushUI({ t: 'toast', level: 'info', text: `Sending ${amount} USD₮ tip…` })
  try {
    const r = await wallet.tip(recipient, amount)
    pushUI({ t: 'toast', level: 'ok', text: `Tip sent · fee ${r.fee}` })
    if (state.room) state.room.broadcast({ type: 'tip', from: state.room.me, name: state.profile.name, to: recipient, amount, hash: r.hash, explorer: r.explorer })
    pushUI({ t: 'tip', from: state.room?.me, name: state.profile.name, amount, hash: r.hash, explorer: r.explorer, to: recipient, self: true })
    ws.send(JSON.stringify({ t: 'balances', balances: await safeBalances() }))
  } catch (e) {
    pushUI({ t: 'toast', level: 'error', text: 'Tip failed: ' + (e?.message || e) })
  }
}

async function safeBalances () {
  try { return await wallet.balances() } catch (e) { return { address: wallet.address, error: String(e?.message || e) } }
}

async function leaveRoom () {
  if (state.room) { await state.room.destroy(); state.room = null; state.polls.clear() }
}

// ---------- boot ----------
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  uiClients.add(ws)
  ws.on('message', (data) => { let m; try { m = JSON.parse(data) } catch { return } handleUI(ws, m).catch((e) => console.error('ui-handler', e)) })
  ws.on('close', () => uiClients.delete(ws))
})

await wallet.init()
state.profile.address = wallet.address // share address so peers can tip us
const ffmpegAvailable = await hasFfmpeg()
server.listen(PORT, () => {
  console.log(`\n🏟️  FanCircle backend — user "${state.profile.name}" (${state.profile.lang})`)
  console.log(`   UI:     http://localhost:${PORT}`)
  console.log(`   Wallet: ${wallet.address} (${CHAIN.name})`)
  console.log(`   USDT:   ${CHAIN.usdt || 'not configured (set FANCIRCLE_USDT to enable tipping)'}`)
  console.log(`   Voice:  ${ffmpegAvailable ? 'ready (ffmpeg found)' : 'DISABLED — install ffmpeg to enable voice notes'}\n`)
})
