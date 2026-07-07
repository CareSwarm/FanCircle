// De-risk the on-device "match assistant" — QVAC LLM completion, grounded + no-think.
//   MODEL=600m|1_7b node spikes/spike-llm.mjs
import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4, QWEN3_1_7B_INST_Q4 } from '@qvac/sdk'

const FACTS = `World Cup 2026 & laws-of-the-game facts (authoritative — use these):
- Knockout extra time is two halves of 15 minutes each = 30 minutes total; if still level, a penalty shootout decides it.
- Offside: a player is offside if they are nearer the opponents' goal line than both the ball and the second-last defender when the ball is played to them, and become involved in active play. Punished by an INDIRECT free kick (never a penalty).
- A match is 90 minutes (two 45-minute halves) plus stoppage time.
- 2026 World Cup: 48 teams, 104 matches, hosts USA/Mexico/Canada; the final is 19 July 2026 at MetLife Stadium.
- A red card means the player is sent off and the team plays with 10; two yellow cards equal a red.`

const SYSTEM = `You are FanCircle's concise football match assistant. Answer in 1-3 short sentences, plainly, for a fan. Only use the facts below; if unsure, say so.\n\n${FACTS}`

const MODELS = { '600m': QWEN3_600M_INST_Q4, '1_7b': QWEN3_1_7B_INST_Q4 }
const pick = process.env.MODEL || '600m'

function strip (s) { return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '').trim() }

async function ask (modelId, q) {
  const res = completion({ modelId, history: [{ role: 'system', content: SYSTEM }, { role: 'user', content: q + ' /no_think' }], stream: true })
  let out = ''
  for await (const tok of res.tokenStream) out += tok
  console.log(`\nQ: ${q}\nA: ${strip(out)}`)
}

async function main () {
  console.log(`[spike-llm] model=${pick}`)
  const modelId = await loadModel({ modelSrc: MODELS[pick], onProgress: () => {} })
  await ask(modelId, 'What is the offside rule?')
  await ask(modelId, 'How long is extra time in a knockout match if the score is level?')
  await ask(modelId, 'When and where is the 2026 World Cup final?')
  await unloadModel({ modelId })
  console.log('\n✅ done')
  process.exit(0)
}
main().catch((e) => { console.error('❌', e?.message || e); process.exit(1) })
