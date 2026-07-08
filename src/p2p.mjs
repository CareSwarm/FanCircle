// P2P room over Hyperswarm - no server, Noise-encrypted direct connections.
// Durable history/tallies are handled separately by roomlog.mjs (Autobase).

import EventEmitter from 'events'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { RoomLog } from './roomlog.mjs'

// Message types worth persisting for late joiners. Reactions are confetti —
// replaying 50 old 🔥 on join would be noise, so they're gossip-only.
const DURABLE_TYPES = new Set(['chat', 'voice', 'assistant', 'poll-create', 'poll-vote', 'tip'])

export class Room extends EventEmitter {
  constructor ({ topic, profile } = {}) {
    super()
    this.swarm = new Hyperswarm()
    this.isCreator = !topic
    this.topic = topic ? b4a.from(topic, 'hex') : crypto.randomBytes(32)
    this.profile = profile || { name: 'anon', lang: 'en' }
    this.me = b4a.toString(this.swarm.keyPair.publicKey, 'hex').slice(0, 6)
    // peerId(hex6) -> { conn, buf, profile }
    this.peers = new Map()

    this.log = new RoomLog()
    this.logKey = null
    this._logFollowed = false

    this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))
  }

  get topicHex () {
    return b4a.toString(this.topic, 'hex')
  }

  async join () {
    if (this.isCreator) {
      this.logKey = await this.log.create()
      this._afterLogReady() // fire-and-forget; own history is empty at t=0
    }
    const discovery = this.swarm.join(this.topic, { server: true, client: true })
    await discovery.flushed()
    return this.topicHex
  }

  async _afterLogReady () {
    try {
      const history = await this.log.history()
      this.emit('log-ready', history)
    } catch {}
  }

  _onConnection (conn, info) {
    const id = b4a.toString(info.publicKey, 'hex').slice(0, 6)
    const peer = { conn, buf: '', profile: { name: id, lang: 'en' } }
    this.peers.set(id, peer)

    // announce ourselves + logKey (if known), so new peers find durable
    // history without a separate link
    this._sendTo(conn, { type: 'hello', from: this.me, profile: this.profile, logKey: this.logKey })

    conn.on('data', (data) => this._onData(id, data))
    conn.on('error', () => {})
    conn.on('close', () => {
      this.peers.delete(id)
      this.emit('peer-leave', { id, profile: peer.profile })
    })
  }

  _onData (id, data) {
    const peer = this.peers.get(id)
    if (!peer) return
    peer.buf += b4a.toString(data)
    // newline-delimited JSON framing
    let nl
    while ((nl = peer.buf.indexOf('\n')) !== -1) {
      const line = peer.buf.slice(0, nl)
      peer.buf = peer.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this._handle(id, peer, msg)
    }
  }

  _handle (id, peer, msg) {
    if (msg.type === 'hello') {
      const firstHello = !peer.helloSeen
      peer.helloSeen = true
      peer.profile = msg.profile || peer.profile
      // hello re-broadcasts once we learn logKey, so only fire peer-join once
      if (firstHello) this.emit('peer-join', { id, profile: peer.profile })
      if (msg.logKey && !this.logKey && !this.isCreator) {
        this.logKey = msg.logKey
        this._followLog(msg.logKey)
      }
      return
    }
    // stamp the network-observed sender id
    msg._peer = id
    if (!msg.senderLang && peer.profile?.lang) msg.senderLang = peer.profile.lang
    if (DURABLE_TYPES.has(msg.type)) this.log.append(msg).catch(() => {})
    this.emit('message', msg)
  }

  async _followLog (logKey) {
    if (this._logFollowed) return
    this._logFollowed = true
    try {
      await this.log.follow(logKey)
      // Now that we know the log, tell peers who might not — closes multi-hop gaps.
      this._broadcastHello()
      await this._afterLogReady()
    } catch {}
  }

  _broadcastHello () {
    for (const { conn } of this.peers.values()) {
      this._sendTo(conn, { type: 'hello', from: this.me, profile: this.profile, logKey: this.logKey })
    }
  }

  _sendTo (conn, obj) {
    try { conn.write(b4a.from(JSON.stringify(obj) + '\n')) } catch {}
  }

  // Broadcast a message object to every connected peer.
  broadcast (obj) {
    const line = b4a.from(JSON.stringify(obj) + '\n')
    for (const { conn } of this.peers.values()) {
      try { conn.write(line) } catch {}
    }
    if (DURABLE_TYPES.has(obj.type)) this.log.append(obj).catch(() => {})
  }

  memberList () {
    return [
      { id: this.me, profile: this.profile, self: true },
      ...[...this.peers.entries()].map(([id, p]) => ({ id, profile: p.profile, self: false }))
    ]
  }

  async destroy () {
    try { await this.swarm.destroy() } catch {}
    try { await this.log.destroy() } catch {}
    this.peers.clear()
  }
}
