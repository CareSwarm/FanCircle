// FanCircle UI — talks to the local backend over WebSocket.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'

let ws, me = null, myProfile = { name: '', lang: 'en' }, chain = {}, members = [], myAddr = null
let tipTarget = null

function connect () {
  ws = new WebSocket(`ws://${location.host}`)
  ws.onopen = () => send({ t: 'init' })
  ws.onmessage = (e) => handle(JSON.parse(e.data))
  ws.onclose = () => setTimeout(connect, 1000)
}
function send (o) { try { ws.send(JSON.stringify(o)) } catch {} }

function handle (m) {
  switch (m.t) {
    case 'ready':
      me = m.me; myProfile = m.profile; chain = m.chain; myAddr = m.address
      $('name').value = myProfile.name
      buildLangs(m.langs)
      $('lang').value = myProfile.lang
      $('addr').textContent = shortAddr(m.address)
      $('addr').title = m.address
      $('tipChain').textContent = chain.name || 'Sepolia'
      if (m.room) showRoom(m.room.topic)
      break
    case 'profile': myProfile = m.profile; break
    case 'balances': renderBalance(m.balances); break
    case 'room': showRoom(m.topic); break
    case 'members': members = m.list; renderMembers(); break
    case 'chat': renderChat(m); break
    case 'reaction': floatReaction(m.emoji); break
    case 'polls': renderPolls(m.polls); break
    case 'tip': renderTip(m); break
    case 'assistant-pending': renderAssistantPending(m); break
    case 'assistant': renderAssistant(m); break
    case 'voice-pending': renderVoicePending(m); break
    case 'voice-pending-clear': if (voicePendingEl) { voicePendingEl.remove(); voicePendingEl = null }; break
    case 'voice': renderVoice(m); break
    case 'system': addSystem(m.text); break
    case 'toast': toast(m.text, m.level); break
  }
}

// ---------- profile ----------
function buildLangs (langs) {
  const sel = $('lang'); sel.innerHTML = ''
  for (const l of langs) { const o = el('option'); o.value = l.code; o.textContent = l.label; sel.appendChild(o) }
}
$('name').addEventListener('change', () => send({ t: 'set-profile', name: $('name').value }))
$('lang').addEventListener('change', () => send({ t: 'set-profile', lang: $('lang').value }))

function renderBalance (b) {
  if (!b) return
  if (b.error) { $('bal').textContent = 'balance n/a'; return }
  const usdt = b.usdt != null ? `${b.usdt} USD₮` : (chain.usdtConfigured ? '0 USD₮' : 'USD₮ not set')
  $('bal').textContent = usdt
  $('bal').title = `${b.nativeEth} ETH (gas)`
}
$('refresh').addEventListener('click', () => send({ t: 'refresh-balance' }))

// ---------- room ----------
$('createRoom').addEventListener('click', () => send({ t: 'create-room' }))
$('joinRoom').addEventListener('click', () => { const v = $('joinInput').value.trim(); if (v) send({ t: 'join-room', topic: v }) })
function showRoom (topic) {
  $('roomInfo').classList.remove('hidden')
  $('roomLink').textContent = topic
  $('chatEmpty')?.remove()
  $('matchTitle').textContent = 'Watch party live · fans chatting in their own language'
}
$('copyLink').addEventListener('click', () => { navigator.clipboard?.writeText($('roomLink').textContent); toast('Room link copied', 'ok') })

function renderMembers () {
  $('memberCount').textContent = members.length
  const ul = $('members'); ul.innerHTML = ''
  for (const mem of members) {
    const li = el('li', 'member')
    li.appendChild(el('span', 'dot'))
    li.appendChild(el('span', 'who', esc(mem.profile.name) + (mem.self ? ' <span class="lng">(you)</span>' : '')))
    li.appendChild(el('span', 'lng', mem.profile.lang.toUpperCase()))
    if (!mem.self) {
      const tip = el('span', 'tip')
      const b = el('button', 'tip-btn', '💸 tip')
      b.addEventListener('click', () => openTip(mem))
      tip.appendChild(b); li.appendChild(tip)
    }
    ul.appendChild(li)
  }
}

// ---------- chat ----------
const chat = $('chat')
function atBottom () { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60 }
function scroll () { chat.scrollTop = chat.scrollHeight }
function renderChat (m) {
  const stick = atBottom()
  const d = el('div', 'msg' + (m.self ? ' self' : ''))
  const head = el('div', 'head', `<span class="nm">${esc(m.name)}</span> <span class="lg">${esc(m.lang || '')}</span>`)
  d.appendChild(head)
  d.appendChild(el('div', 'orig', esc(m.text)))
  if (m.translated && m.translated !== m.text) d.appendChild(el('div', 'trans', esc(m.translated)))
  chat.appendChild(d)
  if (stick) scroll()
}
function addSystem (t) { chat.appendChild(el('div', 'system', esc(t))); if (atBottom()) scroll() }

$('composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const v = $('msg').value.trim(); if (!v) return
  send({ t: 'chat', text: v }); $('msg').value = ''
})
document.querySelectorAll('.react').forEach((b) => b.addEventListener('click', () => send({ t: 'reaction', emoji: b.dataset.e })))

function floatReaction (emoji) {
  const layer = $('reactionLayer')
  const s = el('div', 'floatimg', emoji)
  s.style.left = (55 + Math.random() * 35) * (window.innerWidth / 100) + 'px'
  s.style.bottom = '120px'
  layer.appendChild(s)
  setTimeout(() => s.remove(), 2400)
}

// ---------- voice notes ----------
const MAX_RECORD_MS = 20000
let mediaRecorder = null, recordedChunks = [], recordTimer = null, recordStart = 0
let voicePendingEl = null

async function startRecording () {
  if (mediaRecorder) return
  if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone not available in this browser', 'error')
  let stream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { return toast('Microphone permission denied', 'error') }
  recordedChunks = []
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || ''
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data) }
  mediaRecorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()) }
  mediaRecorder.start()
  recordStart = Date.now()
  $('micBtn').classList.add('active')
  $('recBar').classList.remove('hidden')
  recordTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000)
    $('recTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    if (s * 1000 >= MAX_RECORD_MS) stopRecording(true)
  }, 250)
}

function stopRecording (send_) {
  if (!mediaRecorder) return
  const mime = mediaRecorder.mimeType || 'audio/webm'
  const finish = () => {
    clearInterval(recordTimer); recordTimer = null
    $('micBtn').classList.remove('active')
    $('recBar').classList.add('hidden')
    $('recTimer').textContent = '0:00'
    mediaRecorder = null
    if (send_ && recordedChunks.length) {
      const blob = new Blob(recordedChunks, { type: mime })
      const reader = new FileReader()
      reader.onload = () => {
        const b64 = reader.result.split(',')[1]
        send({ t: 'voice', audio: b64, mime })
      }
      reader.readAsDataURL(blob)
    }
    recordedChunks = []
  }
  mediaRecorder.addEventListener('stop', finish, { once: true })
  mediaRecorder.stop()
}

$('micBtn').addEventListener('click', () => { mediaRecorder ? stopRecording(true) : startRecording() })
$('recStop').addEventListener('click', () => stopRecording(true))
$('recCancel').addEventListener('click', () => stopRecording(false))

function renderVoicePending (m) {
  const stick = atBottom()
  voicePendingEl = el('div', 'msg voice')
  voicePendingEl.innerHTML = `<div class="vhead"><span class="nm">${esc(m.name)}</span></div><div class="thinking">🎙️ transcribing on-device…</div>`
  chat.appendChild(voicePendingEl)
  if (stick) scroll()
}
function renderVoice (m) {
  if (voicePendingEl) { voicePendingEl.remove(); voicePendingEl = null }
  const stick = atBottom()
  const d = el('div', 'msg voice' + (m.self ? ' self' : ''))
  let html = `<div class="vhead"><span class="nm">${esc(m.name)}</span> <span class="lg">${esc(m.lang || '')}</span> 🎙️</div>`
  if (m.audio) html += `<audio controls src="data:${esc(m.mime || 'audio/webm')};base64,${m.audio}"></audio>`
  html += `<div class="orig">${esc(m.text)}</div>`
  if (m.translated && m.translated !== m.text) html += `<div class="trans">${esc(m.translated)}</div>`
  d.innerHTML = html
  chat.appendChild(d)
  if (stick) scroll()
}

// ---------- tips ----------
function openTip (mem) {
  tipTarget = mem
  $('tipName').textContent = mem.profile.name
  const addr = mem.profile.address
  if (!addr) return toast(`${mem.profile.name} has no wallet address yet`, 'error')
  $('tipAddr').textContent = addr
  $('tipModal').classList.remove('hidden')
}
document.querySelectorAll('#tipModal .chip').forEach((c) => c.addEventListener('click', () => { $('tipAmt').value = c.dataset.amt }))
$('tipCancel').addEventListener('click', () => $('tipModal').classList.add('hidden'))
$('tipSend').addEventListener('click', () => {
  const amount = Number($('tipAmt').value)
  const recipient = ($('tipAddr').textContent || '').trim()
  send({ t: 'tip', recipient, amount })
  $('tipModal').classList.add('hidden')
})
function renderTip (m) {
  const wrap = el('div', 'tip-msg')
  const link = m.explorer ? ` · <a href="${esc(m.explorer)}" target="_blank">view tx</a>` : ''
  wrap.innerHTML = `💸 <b>${esc(m.name || 'someone')}</b> tipped ${esc(m.amount)} USD₮${link}`
  chat.appendChild(wrap); if (atBottom()) scroll()
}

let pendingEl = null
function renderAssistantPending (m) {
  const stick = atBottom()
  pendingEl = el('div', 'msg assistant')
  pendingEl.innerHTML = `<div class="head"><span class="bot">🤖 Match Assistant</span> · asked by ${esc(m.name)}</div><div class="q">${esc(m.question)}</div><div class="thinking">thinking on-device…</div>`
  chat.appendChild(pendingEl)
  if (stick) scroll()
}
function renderAssistant (m) {
  const stick = atBottom()
  if (pendingEl) { pendingEl.remove(); pendingEl = null }
  const d = el('div', 'msg assistant')
  let html = `<div class="head"><span class="bot">🤖 Match Assistant</span> · asked by ${esc(m.name)}</div>`
  html += `<div class="q">${esc(m.question)}</div>`
  html += `<div class="ans">${esc(m.answer)}</div>`
  if (m.translated && m.translated !== m.answer) html += `<div class="trans">${esc(m.translated)}</div>`
  d.innerHTML = html
  chat.appendChild(d)
  if (stick) scroll()
}

// ---------- polls ----------
$('newPoll').addEventListener('click', () => $('pollModal').classList.remove('hidden'))
$('pollCancel').addEventListener('click', () => $('pollModal').classList.add('hidden'))
$('pollCreate').addEventListener('click', () => {
  const question = $('pollQ').value.trim()
  const options = ['pollO1', 'pollO2', 'pollO3', 'pollO4'].map((id) => $(id).value.trim()).filter(Boolean)
  if (!question || options.length < 2) return toast('Need a question and 2+ options', 'error')
  send({ t: 'poll-create', question, options })
  $('pollModal').classList.add('hidden')
  ;['pollQ', 'pollO1', 'pollO2', 'pollO3', 'pollO4'].forEach((id) => { $(id).value = '' })
})
function renderPolls (polls) {
  const box = $('polls'); box.innerHTML = ''
  for (const p of polls) {
    const card = el('div', 'poll')
    card.appendChild(el('div', 'q', esc(p.question)))
    const max = Math.max(1, ...p.tally)
    p.options.forEach((opt, i) => {
      const row = el('div', 'opt')
      const pct = p.total ? Math.round((p.tally[i] / p.total) * 100) : 0
      row.innerHTML = `<div class="bar-wrap"><div class="barbg"><div class="bar" style="width:${(p.tally[i] / max) * 100}%"></div><span class="lbl">${esc(opt)} · ${pct}%</span></div><span class="cnt">${p.tally[i]}</span></div>`
      row.addEventListener('click', () => send({ t: 'poll-vote', pollId: p.id, optionIndex: i }))
      card.appendChild(row)
    })
    card.appendChild(el('div', 'total', `${p.total} vote${p.total === 1 ? '' : 's'}`))
    box.appendChild(card)
  }
}

// ---------- toasts ----------
function toast (text, level = 'info') {
  const t = el('div', 'toast ' + level, esc(text))
  $('toasts').appendChild(t)
  setTimeout(() => t.remove(), 4000)
}

connect()
