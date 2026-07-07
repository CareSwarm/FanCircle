// Browser records webm/opus; QVAC's decoder only auto-handles mp3/m4a/ogg/
// wav/flac/aac, so convert to wav with ffmpeg before transcribe().

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const execFileP = promisify(execFile)

let ffmpegChecked = false
let ffmpegOk = false
export async function hasFfmpeg () {
  if (ffmpegChecked) return ffmpegOk
  ffmpegChecked = true
  try { await execFileP('ffmpeg', ['-version']); ffmpegOk = true } catch { ffmpegOk = false }
  return ffmpegOk
}

const MAX_BYTES = 8 * 1024 * 1024 // ~8MB safety cap for a short voice note

// Decodes a base64 audio blob (any ffmpeg-readable container, e.g. webm/opus
// from the browser) into a 16kHz mono WAV temp file. Caller must unlink it.
export async function base64ToWav (base64, srcExt = 'webm') {
  const buf = Buffer.from(base64, 'base64')
  if (buf.length > MAX_BYTES) throw new Error('voice note too large')
  if (!(await hasFfmpeg())) throw new Error('ffmpeg not found on this machine — required for voice notes')

  const tag = crypto.randomBytes(6).toString('hex')
  const inPath = path.join(os.tmpdir(), `fc-voice-${tag}-in.${srcExt}`)
  const outPath = path.join(os.tmpdir(), `fc-voice-${tag}-out.wav`)
  await fs.promises.writeFile(inPath, buf)
  try {
    await execFileP('ffmpeg', ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', outPath])
  } finally {
    fs.promises.unlink(inPath).catch(() => {})
  }
  return outPath
}

export async function cleanup (wavPath) {
  if (wavPath) fs.promises.unlink(wavPath).catch(() => {})
}
