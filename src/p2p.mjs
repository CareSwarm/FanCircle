// TRACK PEARS — peer-to-peer room over the Holepunch Hyperswarm DHT.
// No application server: peers find each other by a shared topic and exchange
// end-to-end-encrypted (Noise) messages directly. This module is intentionally
// self-contained so it can be lifted into a Bare worklet for native Pear-app
// packaging without changing the message protocol.

import EventEmitter from 'events'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

export class Room extends EventEmitter {
  constructor ({ topic, profile } = {}) {
    super()
    this.swarm = new Hyperswarm()
    this.topic = topic ? b4a.from(topic, 'hex') : crypto.randomBytes(32)
    this.profile = profile || { name: 'anon', lang: 'en' }
    this.me = b4a.toString(this.swarm.keyPair.publicKey, 'hex').slice(0, 6)
    // peerId(hex6) -> { conn, buf, profile }
    this.peers = new Map()

    this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))
  }

  get topicHex () {
    return b4a.toString(this.topic, 'hex')
  }

  async join () {
    const discovery = this.swarm.join(this.topic, { server: true, client: true })
    await discovery.flushed()
    return this.topicHex
  }

  _onConnection (conn, info) {
    const id = b4a.toString(info.publicKey, 'hex').slice(0, 6)
    const peer = { conn, buf: '', profile: { name: id, lang: 'en' } }
    this.peers.set(id, peer)

    // Announce who we are so others can label + translate our messages.
    this._sendTo(conn, { type: 'hello', from: this.me, profile: this.profile })

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
      peer.profile = msg.profile || peer.profile
      this.emit('peer-join', { id, profile: peer.profile })
      return
    }
    // stamp the network-observed sender id
    msg._peer = id
    if (!msg.senderLang && peer.profile?.lang) msg.senderLang = peer.profile.lang
    this.emit('message', msg)
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
  }

  memberList () {
    return [
      { id: this.me, profile: this.profile, self: true },
      ...[...this.peers.entries()].map(([id, p]) => ({ id, profile: p.profile, self: false }))
    ]
  }

  async destroy () {
    try { await this.swarm.destroy() } catch {}
    this.peers.clear()
  }
}
