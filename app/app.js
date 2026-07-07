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
