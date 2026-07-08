// Autobase multi-writer log over real Hyperswarm - proves convergence,
// late-join replication, and matching poll tallies across 3 peers.
//   node spikes/spike-autobase.mjs

import Autobase from 'autobase'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// Corestore 7 is RocksDB-backed and needs a real directory (no more in-memory
// random-access-storage factory). Use a fresh temp dir per instance/room.
function tmpStoreDir () { return path.join(os.tmpdir(), 'fc-autobase-' + crypto.randomBytes(6).toString('hex')) }

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, host) {
  for (const { value } of nodes) {
    if (value?.addWriter) { await host.addWriter(b4a.from(value.addWriter, 'hex'), { indexer: true }); continue }
    await view.append(value)
  }
}

async function makeBase (name, bootstrapKey) {
  const store = new Corestore(tmpStoreDir())
  const base = new Autobase(store, bootstrapKey || null, { open, apply, valueEncoding: 'json' })
  await base.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  await swarm.join(base.discoveryKey, { server: true, client: true }).flushed()
  console.log(`[${name}] ready. key=${b4a.toString(base.key, 'hex').slice(0, 12)}… local=${b4a.toString(base.local.key, 'hex').slice(0, 12)}… writable=${base.writable}`)
  return { name, base, swarm, store }
}

async function readAll (base) {
  await base.view.update?.().catch(() => {})
  const out = []
  for (let i = 0; i < base.view.length; i++) out.push(await base.view.get(i))
  return out
}

function tally (entries, pollId) {
  const votes = new Map()
  for (const e of entries) if (e?.type === 'vote' && e.pollId === pollId) votes.set(e.voter, e.option)
  const t = [0, 0]
  for (const opt of votes.values()) t[opt]++
  return t
}

async function waitUntil (fn, ms = 15000, step = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return false
}

async function main () {
  console.log('=== Autobase multi-writer spike ===\n')

  const creator = await makeBase('creator')

  const joiner = await makeBase('joiner', creator.base.key)
  console.log('\n[creator] adding joiner as a writer…')
  await creator.base.append({ addWriter: b4a.toString(joiner.base.local.key, 'hex') })

  const joinerWritable = await waitUntil(async () => { await joiner.base.update(); return joiner.base.writable })
  console.log('[joiner] became writable:', joinerWritable)
  if (!joinerWritable) throw new Error('joiner never became writable — addWriter propagation failed')

  console.log('\nappending messages from both writers…')
  await creator.base.append({ type: 'chat', from: 'creator', text: 'room is open' })
  await joiner.base.append({ type: 'chat', from: 'joiner', text: 'hey, joined!' })
  await creator.base.append({ type: 'vote', pollId: 'p1', voter: 'creator', option: 0 })
  await joiner.base.append({ type: 'vote', pollId: 'p1', voter: 'joiner', option: 1 })

  const converged = await waitUntil(async () => {
    await creator.base.update(); await joiner.base.update()
    return creator.base.view.length === joiner.base.view.length && creator.base.view.length >= 4
  })
  console.log('creator+joiner converged:', converged, 'view length', creator.base.view.length, joiner.base.view.length)

  const cEntries = await readAll(creator.base)
  const jEntries = await readAll(joiner.base)
  console.log('\ncreator view:', cEntries.map((e) => e.type === 'chat' ? `chat:${e.text}` : `vote:${e.voter}->${e.option}`))
  console.log('joiner  view:', jEntries.map((e) => e.type === 'chat' ? `chat:${e.text}` : `vote:${e.voter}->${e.option}`))
  const sameOrder = JSON.stringify(cEntries) === JSON.stringify(jEntries)
  console.log(sameOrder ? '✅ identical linearized view on both writers' : '❌ views diverged')

  // Late joiner: connects AFTER all the above, should replicate FULL history via the swarm.
  console.log('\n[late] a third peer joins after messages already exist…')
  const late = await makeBase('late', creator.base.key)
  const lateSynced = await waitUntil(async () => { await late.base.update(); return late.base.view.length === creator.base.view.length })
  console.log('[late] synced full history without being present when it was written:', lateSynced, 'view length', late.base.view.length)
  const lateEntries = await readAll(late.base)
  const lateSameOrder = JSON.stringify(lateEntries) === JSON.stringify(cEntries)
  console.log(lateSameOrder ? '✅ late joiner replicated identical history' : '❌ late joiner history mismatch')

  const t1 = tally(cEntries, 'p1')
  const t2 = tally(jEntries, 'p1')
  const t3 = tally(lateEntries, 'p1')
  console.log('\npoll tally — creator:', t1, 'joiner:', t2, 'late:', t3)
  const tallyOk = JSON.stringify(t1) === JSON.stringify(t2) && JSON.stringify(t2) === JSON.stringify(t3)
  console.log(tallyOk ? '✅ poll tally converges identically on all three peers' : '❌ poll tally mismatch')

  await Promise.all([creator, joiner, late].map(async (p) => { await p.swarm.destroy(); await p.base.close() }))

  const ok = converged && sameOrder && lateSynced && lateSameOrder && tallyOk
  console.log('\n' + (ok ? '✅ AUTOBASE SPIKE PASS' : '❌ AUTOBASE SPIKE FAIL'))
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('❌', e?.stack || e?.message || e); process.exit(1) })
