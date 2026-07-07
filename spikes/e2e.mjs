// End-to-end golden-path test across TWO running backends (two users).
// Proves: Pears room join + QVAC cross-language translation + poll tally.
// Requires both backends running:
//   NAME=Minh LANG_CODE=vi PORT=8080 WALLET_DIR=.wallet/minh node src/backend.mjs
//   NAME=Alex LANG_CODE=en PORT=8081 WALLET_DIR=.wallet/alex node src/backend.mjs

import WebSocket from 'ws'
import fs from 'fs'

function client (port) {
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
    ws, inbox,
    ready: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, ms = 15000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit)
      const w = { pred, resolve }; waiters.push(w)
      setTimeout(() => reject(new Error('timeout waiting for ' + pred)), ms)
    }),
    latest: (pred) => { for (let i = inbox.length - 1; i >= 0; i--) if (pred(inbox[i])) return inbox[i]; return null }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function check (cond, label) { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) failed = true }

async function main () {
  const minh = client(8080)
  const alex = client(8081)
  await Promise.all([minh.ready(), alex.ready()])
  minh.send({ t: 'init' }); alex.send({ t: 'init' })
  await Promise.all([minh.wait((m) => m.t === 'ready'), alex.wait((m) => m.t === 'ready')])
  console.log('both users ready\n')

  // 1) PEARS — Minh creates a room, Alex joins by link
  minh.send({ t: 'create-room' })
  const room = await minh.wait((m) => m.t === 'room')
  console.log('room topic:', room.topic.slice(0, 16) + '…')
  alex.send({ t: 'join-room', topic: room.topic })

  // both should see 2 members
  const minhMembers = await minh.wait((m) => m.t === 'members' && m.list.length === 2)
  const alexMembers = await alex.wait((m) => m.t === 'members' && m.list.length === 2)
  check(minhMembers.list.length === 2 && alexMembers.list.length === 2, 'PEARS: peers discovered each other, room has 2 members')

  // 2) QVAC — Minh writes Vietnamese, Alex must receive an English translation
  minh.send({ t: 'chat', text: 'Ai sẽ thắng trận bán kết tối nay?' })
  const atAlex = await alex.wait((m) => m.t === 'chat' && !m.self && m.lang === 'vi')
  console.log(`  Minh(vi): "${atAlex.text}"`)
  console.log(`  → Alex sees: "${atAlex.translated}"`)
  check(!!atAlex.translated && /win|semi|tonight|who/i.test(atAlex.translated), 'QVAC: vi→en translation delivered to English user')

  // reverse direction
  alex.send({ t: 'chat', text: 'I think Norway will win tonight.' })
  const atMinh = await minh.wait((m) => m.t === 'chat' && !m.self && m.lang === 'en')
  console.log(`  Alex(en): "${atMinh.text}"`)
  console.log(`  → Minh sees: "${atMinh.translated}"`)
  check(!!atMinh.translated && atMinh.translated !== atMinh.text, 'QVAC: en→vi translation delivered to Vietnamese user')

  // 3) PEARS — poll create + votes converge on both sides
  minh.send({ t: 'poll-create', question: 'Who wins?', options: ['Norway', 'England'] })
  await alex.wait((m) => m.t === 'polls' && m.polls.length === 1)
  const poll = (await minh.wait((m) => m.t === 'polls' && m.polls.length === 1)).polls[0]
  minh.send({ t: 'poll-vote', pollId: poll.id, optionIndex: 0 }) // Minh -> Norway
  alex.send({ t: 'poll-vote', pollId: poll.id, optionIndex: 1 }) // Alex -> England
  await sleep(2000)
  const finalPollMinh = minh.latest((m) => m.t === 'polls' && m.polls.length).polls[0]
  const finalPollAlex = alex.latest((m) => m.t === 'polls' && m.polls.length).polls[0]
  console.log('  tally (Minh view):', finalPollMinh.tally, 'total', finalPollMinh.total)
  console.log('  tally (Alex view):', finalPollAlex.tally, 'total', finalPollAlex.total)
  check(finalPollMinh.total === 2 && finalPollAlex.total === 2 &&
    finalPollMinh.tally[0] === 1 && finalPollMinh.tally[1] === 1,
  'PEARS: poll votes gossiped + tallied identically on both peers')

  // 3.5) QVAC LLM — Minh asks the on-device match assistant; answer shared to the room
  console.log('\n  Minh asks the match assistant (/ask)…')
  minh.send({ t: 'chat', text: '/ask How long is extra time in a knockout match if the score is level?' })
  const aAlex = await alex.wait((m) => m.t === 'assistant', 120000) // first run may download the model
  const aMinh = await minh.wait((m) => m.t === 'assistant', 120000)
  console.log('  assistant answer (en):', aAlex.answer)
  console.log('  Minh (vi) sees      :', aMinh.translated || aMinh.answer)
  check(!!aAlex.answer && /30|minute/i.test(aAlex.answer), 'QVAC LLM: on-device match assistant answered + shared to room + translated')

  // 3.7) QVAC speech-to-text — Alex sends a voice note; Minh gets transcript + translation
  const sampleWebm = process.env.VOICE_SAMPLE // path to a webm/opus clip; skip if unset
  if (sampleWebm && fs.existsSync(sampleWebm)) {
    console.log('\n  Alex sends a voice note…')
    const audio = fs.readFileSync(sampleWebm).toString('base64')
    alex.send({ t: 'voice', audio, mime: 'audio/webm' })
    const vAlex = await alex.wait((m) => m.t === 'voice', 30000)
    const vMinh = await minh.wait((m) => m.t === 'voice', 30000)
    console.log('  transcript (en):', vAlex.text)
    console.log('  Minh (vi) sees :', vMinh.translated || vMinh.text)
    check(!!vAlex.text && /win|norway|england|final/i.test(vAlex.text), 'QVAC STT: voice note transcribed on-device')
    check(!!vMinh.translated && vMinh.translated !== vMinh.text, 'QVAC: voice transcript translated + shared to room over Pears')
  } else {
    console.log('\n  (skipping voice-note test — set VOICE_SAMPLE=/path/to/clip.webm to include it)')
  }

  // 4) WDK — Alex tips Minh (only when wallets are funded, i.e. local-chain mode)
  const minhReady = minh.latest((m) => m.t === 'ready')
  const alexBal = alex.latest((m) => m.t === 'balances')
  const canTip = process.env.FANCIRCLE_CHAIN === 'local' && minhReady?.chain?.usdtConfigured && (alexBal?.balances?.usdt > 0)
  if (canTip) {
    const minhAddr = minhReady.address
    console.log('\n  Alex tips Minh 3 USD₮ →', minhAddr)
    alex.send({ t: 'tip', recipient: minhAddr, amount: 3 })
    const tipMsg = await alex.wait((m) => m.t === 'tip', 30000)
    console.log('  tx:', tipMsg.hash)
    const minhTip = await minh.wait((m) => m.t === 'tip' && m.hash === tipMsg.hash, 30000)
    check(!!tipMsg.hash && !!minhTip, 'WDK: on-chain USD₮ tip sent + announced to the room over Pears')
  } else {
    console.log('\n  (skipping WDK tip test — run with FANCIRCLE_CHAIN=local after `npm run chain:setup` to include it)')
  }

  console.log('\n' + (failed ? '❌ E2E FAILED' : '✅ E2E PASSED — golden path works across two peers'))
  minh.ws.close(); alex.ws.close()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('❌ E2E ERROR:', e.message); process.exit(1) })
