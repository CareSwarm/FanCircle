// TRACK PEARS, deeper — a durable, replicated room log built on Autobase.
// The room creator holds the single writer; every peer (including the
// creator) replicates the resulting view over its own Hyperswarm swarm, so a
// fan who joins after messages/votes happened still gets full history and an
// authoritative poll tally — not just whatever gossip arrived after they
// connected. Runs on a SEPARATE Hyperswarm instance from the room's live
// gossip connections: Corestore replication is a Protomux-multiplexed
// protocol that owns the whole stream it's attached to, so it can't safely
// share a socket with the raw newline-JSON gossip in src/p2p.mjs.
//
// Multi-writer (peers appending directly via Autobase's addWriter) works —
// proven in spikes/spike-autobase.mjs — and is a natural upgrade; the single
// writer here keeps join-time coordination simple for the MVP.

import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view) {
  for (const { value } of nodes) await view.append(value)
}

export class RoomLog {
  constructor () {
    this.dir = path.join(os.tmpdir(), 'fc-log-' + crypto.randomBytes(6).toString('hex'))
    this.store = null
    this.base = null
    this.swarm = null
    this.writable = false
  }

  // Room creator: a fresh writable log. Returns the hex key to share with peers.
  async create () {
    this.store = new Corestore(this.dir)
    this.base = new Autobase(this.store, null, { open, apply, valueEncoding: 'json' })
    await this.base.ready()
    this.writable = true
    await this._join()
    return b4a.toString(this.base.key, 'hex')
  }

  // Joining peer: a read-only replica of someone else's log.
  async follow (keyHex) {
    this.store = new Corestore(this.dir)
    this.base = new Autobase(this.store, b4a.from(keyHex, 'hex'), { open, apply, valueEncoding: 'json' })
    await this.base.ready()
    await this._join()
  }

  async _join () {
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn) => this.store.replicate(conn))
    await this.swarm.join(this.base.discoveryKey, { server: true, client: true }).flushed()
  }

  async append (value) {
    if (!this.writable || !this.base) return false
    await this.base.append(value)
    return true
  }

  async history () {
    if (!this.base) return []
    await this.base.update().catch(() => {})
    const out = []
    for (let i = 0; i < this.base.view.length; i++) out.push(await this.base.view.get(i))
    return out
  }

  async destroy () {
    try { await this.swarm?.destroy() } catch {}
    try { await this.base?.close() } catch {}
    if (this.dir) fs.rm(this.dir, { recursive: true, force: true }, () => {})
  }
}
