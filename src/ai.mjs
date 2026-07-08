// On-device translation (Bergamot) and voice transcription (Whisper) via
// the QVAC SDK, no cloud calls.

import * as qvac from '@qvac/sdk'
import { detectOne } from '@qvac/langdetect-text'

// All Bergamot models are English-centric (X<->EN). Non-English X->Y pivots through EN.
function pairConst (from, to) {
  return qvac['BERGAMOT_' + from.toUpperCase() + '_' + to.toUpperCase()]
}

// `from` is just the profile setting, not what they actually typed - detect
// the real language instead (fixed "offside rule?" -> "Outside the rules?").
function detectLang (text) {
  try {
    const r = detectOne(text)
    return r?.code && r.code !== 'und' ? r.code : null
  } catch { return null }
}

// shared model registry can throw a transient lock error under concurrent
// access ("File descriptor could not be locked"), just retry.
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

export class AI {
  constructor () {
    // cache: "from>to" -> Promise<modelId>
    this._models = new Map()
    // serialize QVAC calls - concurrent translate()/transcribe() cross-
    // contaminate token streams between requests.
    this._queue = Promise.resolve()
  }

  _serialize (fn) {
    const run = this._queue.then(fn, fn)
    this._queue = run.catch(() => {})
    return run
  }

  _loadPair (from, to) {
    const key = `${from}>${to}`
    if (this._models.has(key)) return this._models.get(key)
    const src = pairConst(from, to)
    if (!src) return null
    const p = withLockRetry(() => qvac.loadModel({ modelSrc: src, modelConfig: { engine: 'Bergamot', from, to } }))
      .catch((e) => { this._models.delete(key); throw e }) // don't cache a permanent failure
    this._models.set(key, p)
    return p
  }

  async _translateDirect (text, from, to) {
    const modelP = this._loadPair(from, to)
    if (!modelP) throw new Error(`no Bergamot pair ${from}->${to}`)
    const modelId = await modelP
    return this._serialize(async () => {
      const res = qvac.translate({ modelId, text, modelType: 'nmtcpp-translation', stream: true })
      let out = ''
      for await (const tok of res.tokenStream) out += tok
      return out.trim()
    })
  }

  // Translate text from -> to, pivoting through English when needed.
  async translate (text, from, to) {
    if (!text) return text
    from = from.toLowerCase(); to = to.toLowerCase()
    const detected = detectLang(text)
    if (detected && detected !== from) from = detected
    if (from === to) return text
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

  // ---- speech-to-text (voice notes) ----
  // language hint is fixed at loadModel time, so cache one model per spoken
  // language. SMALL not BASE - base dropped words on casual speech and lost
  // VI tone marks in testing.
  _whisperModel (lang, onProgress) {
    const key = lang || 'auto'
    if (!this._whisper) this._whisper = new Map()
    if (!this._whisper.has(key)) {
      const p = withLockRetry(() => qvac.loadModel({
        modelSrc: qvac.WHISPER_SMALL_Q8_0,
        modelConfig: {
          audio_format: 'f32le',
          suppress_blank: true,
          suppress_nst: true,
          temperature: 0.0,
          ...(lang ? { language: lang } : { detect_language: true })
        },
        onProgress
      })).catch((e) => { this._whisper.delete(key); throw e })
      this._whisper.set(key, p)
    }
    return this._whisper.get(key)
  }

  // audioFilePath must be a decoded PCM/WAV-family file (see src/voice.mjs).
  async transcribe (audioFilePath, lang, onProgress) {
    const modelId = await this._whisperModel(lang, onProgress)
    return this._serialize(async () => {
      const text = await qvac.transcribe({ modelId, audioChunk: audioFilePath })
      return text.trim()
    })
  }
}
