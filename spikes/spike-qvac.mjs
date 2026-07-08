// TRACK QVAC - on-device translation via QVAC SDK, no cloud.
// First run downloads Bergamot (~20-35MB/pair), then cached.
//   node spikes/spike-qvac.mjs

import { loadModel, translate, unloadModel, BERGAMOT_EN_VI, BERGAMOT_VI_EN } from '@qvac/sdk'

async function run (pair, from, to, text) {
  console.log(`\n=== ${from} -> ${to} ===`)
  console.log('input:', text)

  const tLoadStart = Date.now()
  let lastPct = -1
  const modelId = await loadModel({
    modelSrc: pair,
    modelConfig: { engine: 'Bergamot', from, to },
    onProgress: (p) => {
      const pct = Math.floor((p?.progress ?? p ?? 0) * 100)
      if (pct !== lastPct && pct % 20 === 0) {
        console.log(`  download ${pct}%`)
        lastPct = pct
      }
    }
  })
  const loadMs = Date.now() - tLoadStart
  console.log(`  model loaded in ${loadMs} ms`)

  const tInfer = Date.now()
  const result = translate({ modelId, text, modelType: 'nmtcpp-translation', stream: true })
  let out = ''
  for await (const token of result.tokenStream) out += token
  const inferMs = Date.now() - tInfer

  console.log('output:', out.trim())
  console.log(`  translated in ${inferMs} ms`)
  await unloadModel({ modelId })
  return { out: out.trim(), loadMs, inferMs }
}

async function main () {
  console.log('[spike-qvac] QVAC on-device translation test (Bergamot NMT)')
  try {
    await run(BERGAMOT_EN_VI, 'en', 'vi', 'Who do you think will win the semi-final tonight?')
    await run(BERGAMOT_VI_EN, 'vi', 'en', 'Trận này Na Uy chấp Anh nửa trái, anh em nghĩ sao?')
    console.log('\n✅ PASS — QVAC translated both directions on-device.')
    process.exit(0)
  } catch (e) {
    console.error('\n❌ FAIL —', e?.stack || e?.message || e)
    process.exit(1)
  }
}

main()
