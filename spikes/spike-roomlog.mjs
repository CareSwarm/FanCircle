// Smoke test for src/roomlog.mjs's public API (create/follow/append/history).
import { RoomLog } from '../src/roomlog.mjs'

async function waitUntil (fn, ms = 15000, step = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)) }
  return false
}

async function main () {
  const host = new RoomLog()
  const key = await host.create()
  console.log('host created log, key:', key.slice(0, 16) + '…')

  await host.append({ type: 'chat', text: 'first message before anyone joins' })
  await host.append({ type: 'poll-vote', pollId: 'p1', voter: 'host', optionIndex: 0 })

  const late = new RoomLog()
  await late.follow(key)
  console.log('late peer following…')

  const synced = await waitUntil(async () => (await late.history()).length === 2)
  const hist = await late.history()
  console.log('late peer synced:', synced, 'history:', hist)

  const ok = synced && hist[0].text === 'first message before anyone joins' && hist[1].pollId === 'p1'
  await host.destroy(); await late.destroy()
  console.log(ok ? '✅ RoomLog PASS' : '❌ RoomLog FAIL')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('❌', e?.stack || e?.message || e); process.exit(1) })
