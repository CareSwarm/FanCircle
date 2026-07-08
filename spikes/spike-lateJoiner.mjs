// Verifies the Autobase-backed RoomLog durability (src/roomlog.mjs) through
// the REAL app stack, not just the isolated spike: Minh (creator) and Alex
// chat + vote, THEN a third peer (Sam) joins the room late and must receive
// full chat history + a correct poll tally via room-log replication — not
// just whatever gossip happens to arrive after they connect.
//
// Requires three backends running:
//   NAME=Minh LANG_CODE=vi PORT=8080 WALLET_DIR=.wallet/minh node src/backend.mjs
//   NAME=Alex LANG_CODE=en PORT=8081 WALLET_DIR=.wallet/alex node src/backend.mjs
//   NAME=Sam  LANG_CODE=es PORT=8082 WALLET_DIR=.wallet/sam  node src/backend.mjs

import WebSocket from 'ws'

function client (port, label) {
  const ws = new WebSocket(`ws://localhost:${port}`)
  const inbox = []
  const waiters = []
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    inbox.push(m)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1) }
    }
  })
  return {
    ws, inbox, label,
    ready: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, ms = 20000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit)
      const w = { pred, resolve }; waiters.push(w)
      setTimeout(() => reject(new Error(`[${label}] timeout waiting for predicate`)), ms)
    }),
    all: (pred) => inbox.filter(pred),
    latest: (pred) => { for (let i = inbox.length - 1; i >= 0; i--) if (pred(inbox[i])) return inbox[i]; return null }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function check (cond, label) { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) failed = true }

async function main () {
  const minh = client(8080, 'minh')
  const alex = client(8081, 'alex')
  await Promise.all([minh.ready(), alex.ready()])
  minh.send({ t: 'init' }); alex.send({ t: 'init' })
  await Promise.all([minh.wait((m) => m.t === 'ready'), alex.wait((m) => m.t === 'ready')])

  minh.send({ t: 'create-room' })
  const room = await minh.wait((m) => m.t === 'room')
  alex.send({ t: 'join-room', topic: room.topic })
  await Promise.all([
    minh.wait((m) => m.t === 'members' && m.list.length === 2),
    alex.wait((m) => m.t === 'members' && m.list.length === 2)
  ])
  console.log('Minh + Alex are in the room.\n')

  console.log('Sending chat + creating + voting a poll BEFORE the late joiner connects…')
  minh.send({ t: 'chat', text: 'Trận này chắc căng đây' })
  await alex.wait((m) => m.t === 'chat' && m.lang === 'vi')
  alex.send({ t: 'chat', text: 'Definitely, could go to penalties' })
  await minh.wait((m) => m.t === 'chat' && m.lang === 'en')

  minh.send({ t: 'poll-create', question: 'Penalties?', options: ['Yes', 'No'] })
  const poll = (await alex.wait((m) => m.t === 'polls' && m.polls.length === 1)).polls[0]
  minh.send({ t: 'poll-vote', pollId: poll.id, optionIndex: 0 })
  alex.send({ t: 'poll-vote', pollId: poll.id, optionIndex: 0 })
  await sleep(1500) // let it settle + let the room-log durably persist it

  console.log('History exists (2 chats + 1 poll w/ 2 votes). Now Sam joins late…\n')

  const sam = client(8082, 'sam')
  await sam.ready()
  sam.send({ t: 'init' })
  await sam.wait((m) => m.t === 'ready')
  sam.send({ t: 'join-room', topic: room.topic })
  await sam.wait((m) => m.t === 'members' && m.list.length === 3)
  console.log('Sam joined. Waiting for room-log backfill…')

  // The backend emits a 'synced' event after replaying room-log history.
  const synced = await sam.wait((m) => m.t === 'synced', 20000).catch(() => null)
  check(!!synced, 'BACKFILL: Sam received a room-log history sync notice')
  if (synced) console.log(`  Synced ${synced.count} earlier updates`)

  await sleep(500)
  const samChats = sam.all((m) => m.t === 'chat')
  check(samChats.some((c) => c.text === 'Trận này chắc căng đây'), "AUTOBASE: Sam's history includes Minh's pre-join Vietnamese message")
  check(samChats.some((c) => c.text === 'Definitely, could go to penalties'), "AUTOBASE: Sam's history includes Alex's pre-join English message")

  // Chat bubbles render immediately; translation patches in via a follow-up
  // 'chat-translated' once ai.translate() resolves (first use of vi/en->es
  // here, so a real cold-cache wait) — wait for those patches explicitly.
  console.log('\nSam chat inbox (should include BOTH pre-join messages):')
  let anyTranslated = false
  for (const c of samChats) {
    const tr = await sam.wait((m) => m.t === 'chat-translated' && m.id === c.id, 30000).catch(() => null)
    console.log(`  [${c.lang}] ${c.text}  ${tr?.translated ? '→ ' + tr.translated : '(no translation)'}`)
    if (tr?.translated) anyTranslated = true
  }
  check(anyTranslated, "AUTOBASE: Sam's backfilled chat was translated on-device into Sam's own language")

  const samPoll = sam.latest((m) => m.t === 'polls' && m.polls.length)?.polls?.[0]
  console.log('\nSam poll view:', samPoll)
  check(!!samPoll && samPoll.total === 2 && samPoll.tally[0] === 2, 'AUTOBASE: Sam sees the correct, pre-existing poll tally (2 votes) despite joining after the vote')

  console.log('\nNo duplicate rendering check…')
  const minhChatCount = minh.all((m) => m.t === 'chat' && m.text === 'Trận này chắc căng đây').length
  check(minhChatCount === 1, 'DEDUP: no message was rendered twice on an existing peer')

  console.log('\n' + (failed ? '❌ LATE-JOINER TEST FAILED' : '✅ LATE-JOINER TEST PASSED — Autobase room-log backfill works end-to-end'))
  minh.ws.close(); alex.ws.close(); sam.ws.close()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('❌ ERROR:', e.stack || e.message); process.exit(1) })
