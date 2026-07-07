// Full voice-note pipeline test: base64 webm (as the browser would send) ->
// ffmpeg decode -> QVAC transcribe, via the actual src/ modules.
//   node spikes/spike-voice2.mjs <webm-file> [lang]
import fs from 'fs'
import { base64ToWav, cleanup, hasFfmpeg } from '../src/voice.mjs'
import { AI } from '../src/ai.mjs'

const file = process.argv[2]
const lang = process.argv[3] || 'en'

async function main () {
  console.log('ffmpeg available:', await hasFfmpeg())
  const b64 = fs.readFileSync(file).toString('base64')
  console.log(`input: ${file} (${Math.round(b64.length / 1024)} KB base64)`)

  const t0 = Date.now()
  const wavPath = await base64ToWav(b64, 'webm')
  console.log(`decoded to wav in ${Date.now() - t0} ms:`, wavPath)

  const ai = new AI()
  const t1 = Date.now()
  const text = await ai.transcribe(wavPath, lang)
  console.log(`transcribed in ${Date.now() - t1} ms`)
  console.log('\nTranscript:', JSON.stringify(text))

  await cleanup(wavPath)
  console.log('\n✅ full pipeline PASS')
  process.exit(0)
}
main().catch((e) => { console.error('❌', e?.stack || e?.message || e); process.exit(1) })
