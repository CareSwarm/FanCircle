// TRACK PEARS - proves Hyperswarm DHT connectivity.
//   node spikes/spike-p2p.mjs             -> self-test, two swarms exchange a message
//   node spikes/spike-p2p.mjs <hex-topic> -> peer mode, run in a 2nd terminal

import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const TIMEOUT_MS = 30_000
const arg = process.argv[2]

function shortKey (key) {
  return b4a.toString(key, 'hex').slice(0, 6)
}

async function selfTest () {
  const topic = crypto.randomBytes(32)
  console.log('[spike-p2p] topic:', b4a.toString(topic, 'hex'))

  const received = { a: false, b: false }
  const done = deferred()

  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()

  swarmA.on('connection', (conn, info) => {
    console.log('[A] connected to peer', shortKey(info.publicKey))
    conn.on('data', (d) => {
      console.log('[A] recv:', b4a.toString(d))
      received.a = true
      maybeDone()
    })
    conn.on('error', () => {})
    conn.write(b4a.from('hello-from-A'))
  })

  swarmB.on('connection', (conn, info) => {
    console.log('[B] connected to peer', shortKey(info.publicKey))
    conn.on('data', (d) => {
      console.log('[B] recv:', b4a.toString(d))
      received.b = true
      maybeDone()
    })
    conn.on('error', () => {})
    conn.write(b4a.from('hello-from-B'))
  })

  function maybeDone () {
    if (received.a && received.b) done.resolve(true)
  }

  console.log('[spike-p2p] joining topic on both swarms (DHT bootstrap)...')
  await Promise.all([
    swarmA.join(topic, { server: true, client: true }).flushed(),
    swarmB.join(topic, { server: true, client: true }).flushed()
  ])
  console.log('[spike-p2p] announced to DHT, waiting for peers to find each other...')

  const timer = setTimeout(() => done.resolve(false), TIMEOUT_MS)
  const ok = await done.promise
  clearTimeout(timer)

  await swarmA.destroy()
  await swarmB.destroy()

  if (ok) {
    console.log('\n✅ PASS — two swarms discovered each other over the DHT and exchanged messages.')
    process.exit(0)
  } else {
    console.log('\n❌ FAIL — peers did not connect within', TIMEOUT_MS / 1000, 's.')
    process.exit(1)
  }
}

async function peerMode (hexTopic) {
  const topic = b4a.from(hexTopic, 'hex')
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn, info) => {
    console.log('[peer] connected to', shortKey(info.publicKey))
    conn.on('data', (d) => console.log('[peer] recv:', b4a.toString(d)))
    conn.on('error', () => {})
    conn.write(b4a.from('hello-from-' + shortKey(swarm.keyPair.publicKey)))
  })
  await swarm.join(topic, { server: true, client: true }).flushed()
  console.log('[peer] joined topic', hexTopic, '— waiting for connections (Ctrl+C to quit)')
}

function deferred () {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

if (arg) peerMode(arg)
else selfTest()
