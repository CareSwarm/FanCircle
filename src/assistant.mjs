// TRACK QVAC — on-device "match assistant". A small grounded LLM (Qwen3-0.6B)
// answers football rules/stats questions locally through the QVAC SDK. Grounding
// with an authoritative facts sheet keeps a tiny model accurate; Block 2 upgrades
// this to the full QVAC RAG pipeline over live match data.

import * as qvac from '@qvac/sdk'

// See src/ai.mjs for why: QVAC's model registry is a single shared cache
// across every process on the machine, which can transiently lock-contend
// when running several FanCircle backends on one dev box for a demo.
async function withLockRetry (fn, { retries = 4, delayMs = 400 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try { return await fn() } catch (e) {
      lastErr = e
      if (!/lock/i.test(e?.message || '')) throw e
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastErr
}

const FACTS = `Laws of the game & World Cup 2026 facts (authoritative):
- A match is 90 minutes: two 45-minute halves, plus stoppage (added) time.
- Knockout extra time is two 15-minute halves = 30 minutes total; if still level, a penalty shootout decides it.
- Offside: a player is offside if nearer the opponents' goal line than both the ball and the second-last defender when the ball is played to them, and then becomes involved in active play. Punished by an INDIRECT free kick — never a penalty.
- Red card: the player is sent off and their team continues with 10 players; two yellow cards in a match equal a red.
- A penalty kick is taken from the penalty spot, 11 metres (12 yards) from goal, only for a direct-free-kick foul committed inside the offender's own penalty area.
- World Cup 2026: 48 teams, 104 matches, hosted by the USA, Mexico and Canada; the final is on 19 July 2026 at MetLife Stadium, New Jersey.
- The tournament runs 11 June to 19 July 2026 — the biggest World Cup ever.`

const SYSTEM = `You are FanCircle's football match assistant for fans watching a game together. Answer ONLY the question asked, in 1-2 short plain sentences. Use only the facts below; if they don't cover it, say you're not sure.\n\n${FACTS}`

export class Assistant {
  constructor (modelSrc) {
    this.modelSrc = modelSrc || qvac.QWEN3_600M_INST_Q4
    this._model = null
    this.loading = false
  }

  async _ensure (onProgress) {
    if (this._model) return this._model
    this.loading = true
    try {
      this._model = await withLockRetry(() => qvac.loadModel({ modelSrc: this.modelSrc, onProgress }))
    } finally { this.loading = false }
    return this._model
  }

  static clean (s) {
    return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '').trim()
  }

  // Answer a question on-device. onProgress reports first-run model download.
  async ask (question, onProgress) {
    const modelId = await this._ensure(onProgress)
    const res = qvac.completion({
      modelId,
      history: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question.trim() + ' /no_think' }
      ],
      stream: true
    })
    let out = ''
    for await (const tok of res.tokenStream) out += tok
    return Assistant.clean(out) || "I'm not sure about that one."
  }
}
