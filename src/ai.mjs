// TRACK QVAC — on-device AI through the QVAC SDK (no cloud APIs).
// MVP surface: text translation via Bergamot NMT with English-pivot for pairs
// that have no direct model. Voice-note transcription (whisper) and the match
// assistant (Qwen completion) plug in here in Block 2.

import * as qvac from '@qvac/sdk'

// All Bergamot models are English-centric (X<->EN). Non-English X->Y pivots through EN.
function pairConst (from, to) {
  return qvac['BERGAMOT_' + from.toUpperCase() + '_' + to.toUpperCase()]
}

export class AI {
  constructor () {
    // cache: "from>to" -> Promise<modelId>
    this._models = new Map()
  }

  _loadPair (from, to) {
    const key = `${from}>${to}`
    if (this._models.has(key)) return this._models.get(key)
    const src = pairConst(from, to)
    if (!src) return null
    const p = qvac.loadModel({ modelSrc: src, modelConfig: { engine: 'Bergamot', from, to } })
    this._models.set(key, p)
    return p
  }

  async _translateDirect (text, from, to) {
    const modelP = this._loadPair(from, to)
    if (!modelP) throw new Error(`no Bergamot pair ${from}->${to}`)
    const modelId = await modelP
    const res = qvac.translate({ modelId, text, modelType: 'nmtcpp-translation', stream: true })
    let out = ''
    for await (const tok of res.tokenStream) out += tok
    return out.trim()
  }

  // Translate text from -> to, pivoting through English when needed.
  async translate (text, from, to) {
    if (!text || from === to) return text
    from = from.toLowerCase(); to = to.toLowerCase()
    // direct pair?
    if (pairConst(from, to)) return this._translateDirect(text, from, to)
    // pivot through english
    if (from !== 'en' && to !== 'en') {
      const mid = await this._translateDirect(text, from, 'en')
      return this._translateDirect(mid, 'en', to)
    }
    throw new Error(`unsupported translation ${from}->${to}`)
  }

  // Preload the pairs a room needs so first messages are instant.
  async warmup (langs, myLang) {
    const jobs = []
    for (const l of new Set(langs)) {
      if (l === myLang) continue
      if (pairConst(l, myLang)) jobs.push(this._loadPair(l, myLang))
      else { // pivot legs
        if (pairConst(l, 'en')) jobs.push(this._loadPair(l, 'en'))
        if (pairConst('en', myLang)) jobs.push(this._loadPair('en', myLang))
      }
    }
    await Promise.allSettled(jobs)
  }
}
