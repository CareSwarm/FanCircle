// De-risk voice notes — TRACK QVAC speech-to-text, multilingual.
//   node spikes/spike-voice.mjs <audio-file> [language-code]
import { loadModel, unloadModel, transcribe, WHISPER_BASE_Q8_0 } from '@qvac/sdk'

const file = process.argv[2]
const lang = process.argv[3] || 'en'
if (!file) { console.error('usage: node spike-voice.mjs <audio-file> [lang]'); process.exit(1) }

async function main () {
  console.log(`[spike-voice] loading WHISPER_BASE_Q8_0 (lang=${lang})…`)
  const t0 = Date.now()
  const modelId = await loadModel({
    modelSrc: WHISPER_BASE_Q8_0,
    modelConfig: { audio_format: 'f32le', language: lang, suppress_blank: true, suppress_nst: true, temperature: 0.0 },
    onProgress: () => {}
  })
  console.log(`  loaded in ${Date.now() - t0} ms`)

  const t1 = Date.now()
  const text = await transcribe({ modelId, audioChunk: file })
  console.log(`  transcribed in ${Date.now() - t1} ms`)
  console.log('\nTranscript:', JSON.stringify(text.trim()))

  await unloadModel({ modelId })
  process.exit(0)
}
main().catch((e) => { console.error('❌', e?.stack || e?.message || e); process.exit(1) })
