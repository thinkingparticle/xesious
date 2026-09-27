/**
 * context.ts — the context engine: a local index over everything a group has said,
 * so "that pricing thing Sara floated last month" can be found without replaying the
 * whole history.
 *
 * The recorded topic logs (state/messages/<chat>/<topic>.jsonl) stay the source of
 * truth. This file keeps a derived, rebuildable index beside them in one SQLite file:
 *
 *   - messages, one row each, with an FTS5 table for keyword search (BM25);
 *   - episodes: each topic cut into stretches of conversation at pauses, because a
 *     single "yes, let's do that" means nothing on its own and a stretch of talk does;
 *   - optionally a vector per episode from a small local embedding model, for
 *     questions that share no words with the answer ("the Friday thing" → "demo day");
 *   - optionally a digest per episode written by a cheap model, which names the ideas
 *     and decisions in plain words (see digest.ts).
 *
 * Search ranks episodes by reciprocal-rank fusion of those signals, scoped to ONE
 * chat: a group's history never answers another group's question.
 *
 * No server, no GPU, nothing outside bun:sqlite unless vectors are wanted — and then
 * only an embedder passed in (see embed.ts), so the index works, and is tested,
 * without one.
 */
import { Database } from 'bun:sqlite'

export interface CtxMessage {
  chat: string
  topic: string          // thread id, or 'main'
  topicTitle?: string
  id: number
  t: number              // unix seconds
  from: string           // display name
  text: string
  replyTo?: number
  bot?: boolean
}

export interface Episode {
  key: string            // chat:topic:firstId
  chat: string
  topic: string
  topicTitle: string
  first: number
  last: number
  t0: number
  t1: number
  ids: number[]
  text: string
}

export interface Embedder {
  name: string
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

export interface Hit {
  episode: Episode
  score: number
  why: string[]          // which signals found it, e.g. ['words', 'meaning']
  matched: number[]      // message ids inside it that matched the words, best first
}

export interface SearchOptions {
  k?: number
  context?: string
  topic?: string
  since?: number
  until?: number
  exclude?: Set<number>
  pool?: number
  now?: number
  recent?: { topic: string; from: number }
  summaries?: { model: string; use: 'with-text' | 'alone' }
  // Vectors from embedSpace(): the talk's ('text') and, with `summaries`, the summaries'.
  meaning?: { embedder: Embedder } | false
  weights?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

// A pause this long ends a stretch of conversation — once the stretch has a few
// messages. Chats pick up and drop threads; forty-five minutes is where most "later
// that day" restarts fall. A quiet topic, though, trickles: two messages in the
// morning, three after lunch, all one discussion. Cut at every pause and the pieces
// are too small to mean anything ("yes, let's do that"), so a stretch shorter than
// EPISODE_MIN_MSGS carries on across a pause, up to EPISODE_HARD_GAP_S.
export const EPISODE_GAP_S = 45 * 60
export const EPISODE_HARD_GAP_S = 12 * 3600
export const EPISODE_MIN_MSGS = 8
export const EPISODE_MAX_MSGS = 30
export const EPISODE_MAX_CHARS = 3500
export type EpisodeRules = { gap?: number; hardGap?: number; minMsgs?: number; maxMsgs?: number; maxChars?: number }

const pad = (n: number) => String(n).padStart(2, '0')
export function dayStamp(t: number): string {
  const d = new Date(t * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const clock = (t: number) => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }

export function episodeLine(m: CtxMessage): string {
  return `[${clock(m.t)}] #${m.id} ${m.from}${m.replyTo ? ` (reply to #${m.replyTo})` : ''}: ${m.text.replace(/\s+/g, ' ').trim()}`
}

// One topic's messages, oldest first, cut at pauses and at a size cap.
export function episodesOf(msgs: CtxMessage[], o: EpisodeRules = {}): Episode[] {
  const gap = o.gap ?? EPISODE_GAP_S, hardGap = o.hardGap ?? EPISODE_HARD_GAP_S, minMsgs = o.minMsgs ?? EPISODE_MIN_MSGS
  const maxMsgs = o.maxMsgs ?? EPISODE_MAX_MSGS, maxChars = o.maxChars ?? EPISODE_MAX_CHARS
  const out: Episode[] = []
  let cur: CtxMessage[] = []
  let chars = 0
  const close = () => {
    if (!cur.length) return
    const f = cur[0], l = cur[cur.length - 1]
    const title = f.topicTitle || (f.topic === 'main' ? 'General' : `topic ${f.topic}`)
    out.push({
      key: `${f.chat}:${f.topic}:${f.id}`, chat: f.chat, topic: f.topic, topicTitle: title,
      first: f.id, last: l.id, t0: f.t, t1: l.t, ids: cur.map(m => m.id),
      text: `${title} — ${dayStamp(f.t)}\n` + cur.map(episodeLine).join('\n'),
    })
    cur = []; chars = 0
  }
  for (const m of msgs) {
    const prev = cur[cur.length - 1]
    const pause = prev ? m.t - prev.t : 0
    if (prev && ((pause > gap && cur.length >= minMsgs) || pause > hardGap || cur.length >= maxMsgs || chars + m.text.length > maxChars)) close()
    cur.push(m); chars += m.text.length
  }
  close()
  return out
}

// ---------------------------------------------------------------------------
// Keyword queries
// ---------------------------------------------------------------------------

// One spelling for what keyboards spell two ways, applied to what is indexed and to
// every query alike: Arabic yeh and kaf (ي ك) typed for the Persian ones (ی ک),
// short-vowel marks and tatweel, Persian and Arabic digits, and the zero-width
// non-joiner, which joins parts of one Persian word (می‌خواهم) that people also type
// with a space or with nothing.
export function normalizeText(s: string): string {
  return s
    .replace(/[\u064A\u0649]/g, '\u06CC').replace(/\u0643/g, '\u06A9').replace(/[\u0629]/g, '\u0647')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200C/g, ' ')
}

const STOP = new Set(('a an the and or but if then so to of in on at by for with from as is are was were be been being it its this that these those ' +
  'i you he she we they me him her us them my your our their mine yours what which who whom whose when where why how do does did done ' +
  'have has had not no yes can could would should will shall may might must about into over under again any all some more most other ' +
  'such only own same than too very just also there here up down out off still ok okay hey hi please thanks thank know think anyone ' +
  'something thing things stuff get got going go let lets say said tell told happened happen whats thats one ' +
  'از به با در که این آن را و یا تا برای هم هست است بود شد شده می نمی ما من تو او شما آنها ایشان چی چه کی کجا چرا چطور ' +
  'رو یه یک دیگه هنوز فقط خیلی اون این‌ها اونا بعد قبل الان باید نباید میشه بشه کنیم کردیم کرد کنه').split(/\s+/).filter(Boolean))

// Everyday English that says nothing about what a chat is about: left out of a
// chat's vocabulary (see ContextIndex.vocabulary).
const COMMON_EN = new Set(('also back been before being both call came come could days does doing done each even every find first from gave give good great going have here into just keep know last left like look made make many maybe more most much must need never next nice only other over part same seem send sent should show since some still such sure take than that them then there these they thing think this those though time today told tomorrow true under until very want well were what when where which while will with without work would yeah your yours sorry please thanks thank okay right really check also fine done dear hello later soon week month year hour minute second' +
  ' http https www com org net html png jpg jpeg photo file sticker gif video voice message forwarded reply').split(/\s+/))

// The words of a question worth searching for, as an FTS5 expression: each word
// quoted (so nothing in it is FTS syntax), longer ones as prefixes, joined with OR
// and ranked by BM25. Empty when nothing is left.
export function ftsQuery(text: string): string {
  const words = (normalizeText(text).toLowerCase().replace(/@\w+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}‌'’-]*/gu) ?? [])
    .map(w => w.replace(/['’]s$/, '').replace(/['’-]+$/g, ''))
    .flatMap(w => w.split(/[‌'’-]+/))
    .filter(w => w.length >= 2 && !STOP.has(w))
  const uniq = [...new Set(words)].slice(0, 24)
  return uniq.map(w => w.length >= 5 ? `"${w}"*` : `"${w}"`).join(' OR ')
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY = 86400

// The stretch of time a question points at, if it says one: "yesterday", "last
// Tuesday", "two weeks ago", "early July", "on 14 August", and the common Persian
// ways of saying the relative ones. Deliberately small: a vague question gets no
// window rather than a wrong one, and the model can still pass dates to the
// search tool itself.
export function timeWindow(text: string, now: number): { since: number; until: number } | undefined {
  const s = normalizeText(text).toLowerCase()
  const startOfDay = (t: number) => t - (t % DAY)
  const today = startOfDay(now)
  const num = (w: string) => ({ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, few: 3 } as Record<string, number>)[w] ?? Number(w)
  if (/\byesterday\b|دیروز/.test(s)) return { since: today - DAY, until: today }
  if (/\btoday\b|this morning|امروز/.test(s)) return { since: today, until: now }
  let m = /\b(\d+|a|an|one|two|three|four|five|six|couple|few)\s+(?:of\s+)?(day|week|month)s?\s+ago\b/.exec(s)
  if (m) {
    const n = num(m[1]), unit = m[2] === 'day' ? DAY : m[2] === 'week' ? 7 * DAY : 30 * DAY
    const at = today - n * unit
    return { since: at - unit / 2 - DAY, until: at + unit / 2 + DAY }
  }
  if (/\blast week\b|هفته (?:پیش|قبل|گذشته)/.test(s)) return { since: today - 14 * DAY, until: today - DAY }
  if (/\bthis week\b|این هفته/.test(s)) return { since: today - 7 * DAY, until: now }
  if (/\blast month\b|ماه (?:پیش|قبل|گذشته)/.test(s)) return { since: today - 60 * DAY, until: today - 20 * DAY }
  m = new RegExp(`\\b(?:last|on|this past)\\s+(${WEEKDAYS.join('|')})\\b`).exec(s)
  if (m) {
    const want = WEEKDAYS.indexOf(m[1])
    const dow = new Date(today * 1000).getUTCDay()
    let back = (dow - want + 7) % 7 || 7
    const at = today - back * DAY
    return { since: at, until: at + DAY }
  }
  const year = new Date(now * 1000).getUTCFullYear()
  const monthStart = (mi: number) => { const y = mi > new Date(now * 1000).getUTCMonth() ? year - 1 : year; return Date.UTC(y, mi, 1) / 1000 }
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')})\\b|\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s)
  if (m) {
    const mi = MONTHS.indexOf(m[2] ?? m[3]), d = Number(m[1] ?? m[4])
    const at = monthStart(mi) + (d - 1) * DAY
    return { since: at - DAY, until: at + 2 * DAY }
  }
  // A month named without a day: the first one that is not still ahead ("the lake
  // house in September… she posted it back in July" means July). "may" only counts
  // where it is plainly the month.
  const thisMonth = new Date(now * 1000).getUTCMonth()
  m = null
  for (const x of s.matchAll(new RegExp(`\\b(early|mid|middle of|late|end of|beginning of|start of)?[\\s-]*(${MONTHS.join('|')})\\b`, 'g'))) {
    if (x[2] === 'may' && !/\b(?:in|early|mid|late|since|during|of)\s+may\b/.test(x[0] + ' ' + s)) continue
    const ahead = MONTHS.indexOf(x[2]) > thisMonth && /\b(?:in|this|next|coming)\s*$/.test(s.slice(0, x.index ?? 0).slice(-12))
    if (ahead) continue
    m = x as RegExpExecArray; break
  }
  if (m) {
    const mi = MONTHS.indexOf(m![2]), a = monthStart(mi), len = new Date(Date.UTC(new Date(a * 1000).getUTCFullYear(), mi + 1, 0)).getUTCDate() * DAY
    const part = m![1] ?? ''
    if (/early|beginning|start/.test(part)) return { since: a, until: a + 12 * DAY }
    if (/mid|middle/.test(part)) return { since: a + 8 * DAY, until: a + 23 * DAY }
    if (/late|end/.test(part)) return { since: a + 18 * DAY, until: a + len }
    return { since: a, until: a + len }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Does a message point back at something?
// ---------------------------------------------------------------------------

// Handing earlier conversation to every message would be noise: "write a regex for
// emails" shares a word with some old discussion of an email migration, and nothing
// else. So the automatic recall only runs for a message that points back — at a
// time, at something said or decided, at "that thing", or at a person in the group —
// and the tools stay there for the model to search on its own either way.
const BACK_EN = new RegExp([
  '\\b(?:that|those|the same)\\b', '\\bagain\\b', '\\bstill\\b', '\\bearlier\\b', '\\bbefore\\b', '\\bback then\\b', '\\blast (?:time|week|month)\\b',
  '\\bremember\\b', '\\bremind\\b', '\\brecall\\b', '\\bwe (?:said|decided|agreed|discussed|talked|planned|chose|picked|settled|dropped|moved|changed)\\b',
  '\\b(?:did|have|were|was|are|do) we\\b', '\\bour\\b', '\\bwho (?:said|suggested|proposed|came up|brought|mentioned|raised|posted|wanted)\\b',
  '\\bwhat(?:ever)? happened\\b', '\\bany (?:news|update)\\b', '\\bupdate on\\b', '\\bstatus of\\b', '\\bwhere are we\\b',
  '\\b(?:idea|plan|proposal|decision|deadline|thing|issue|problem|deal|call|meeting|discussion|thread)\\b',
].join('|'), 'i')
const BACK_FA = /(?:^|\s)(?:اون|همون|همین|یادته|یادتونه|یادتون|قبلا|قبلاً|گفتیم|گفتی|گفته|تصمیم|چی شد|هنوز|دوباره|پیش|قبل|پارسال|دیروز|جلسه|ایده|قرار)(?:\s|$|[؟?.!،,])/
export function refersBack(text: string, o: { names?: string[]; now?: number } = {}): boolean {
  const s = normalizeText(text).replace(/@\w+/g, ' ')
  if (BACK_EN.test(s) || BACK_FA.test(s)) return true
  if (timeWindow(s, o.now ?? Date.now() / 1000)) return true
  const low = s.toLowerCase()
  return (o.names ?? []).some(n => n.length >= 3 && new RegExp(`(?:^|[^\\p{L}])${n.toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:$|[^\\p{L}])`, 'u').test(low))
}

// What a turn is handed without asking: for a message that points back, up to
// `max` stretches found by two signals (or by several of their messages); for any
// other message, nothing — the model still has the search tools. Measured in
// research/context: without the gate, 9 of 10 questions that had nothing to do with
// the past came with three stretches of old talk; with it, 1 of 10.
// `strength: false` for an engine that ranks by a single signal of its own (an
// external one): its top results are taken as they come.
export function recallPick(hits: Hit[], text: string, o: { names?: string[]; now?: number; max?: number; strength?: boolean } = {}): Hit[] {
  if (!refersBack(text, o)) return []
  return (o.strength === false ? hits : hits.filter(h => h.why.length >= 2 || h.matched.length >= 2)).slice(0, o.max ?? 3)
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

// Reciprocal-rank fusion: a result's score is the sum over lists of 1/(k + rank).
// Rank-based, so BM25 scores and cosine similarities never have to be made
// comparable; k = 60 is the constant from the original paper and the usual default.
export function rrf(lists: { name: string; ids: string[]; weight?: number }[], k = 60): Map<string, { score: number; why: string[] }> {
  const out = new Map<string, { score: number; why: string[] }>()
  for (const l of lists) {
    l.ids.forEach((id, i) => {
      const e = out.get(id) ?? { score: 0, why: [] }
      e.score += (l.weight ?? 1) / (k + i + 1)
      if (!e.why.includes(l.name)) e.why.push(l.name)
      out.set(id, e)
    })
  }
  return out
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? s / Math.sqrt(na * nb) : 0
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export class ContextIndex {
  readonly db: Database
  private vecCache = new Map<string, Map<string, Float32Array>>()   // chat → episode key → vector

  embedder?: Embedder

  constructor(path: string, embedder?: Embedder, readonly rules: EpisodeRules = {}) {
    this.embedder = embedder
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    // The bridge, a turn's history tools and a bulk summary run may all have it open.
    this.db.run('PRAGMA busy_timeout = 10000')
    this.db.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    this.db.run(`CREATE TABLE IF NOT EXISTS msgs (chat TEXT NOT NULL, topic TEXT NOT NULL, id INTEGER NOT NULL, t INTEGER NOT NULL,
      author TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER, bot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat, id))`)
    this.db.run(`CREATE TABLE IF NOT EXISTS topics (chat TEXT NOT NULL, topic TEXT NOT NULL, title TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (chat, topic))`)
    this.db.run(`CREATE TABLE IF NOT EXISTS episodes (ekey TEXT PRIMARY KEY, chat TEXT NOT NULL, topic TEXT NOT NULL, first_id INTEGER NOT NULL,
      last_id INTEGER NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, ids TEXT NOT NULL, text TEXT NOT NULL, digest TEXT,
      vec BLOB, vec_model TEXT)`)
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, author, chat UNINDEXED, id UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2')`)
    this.db.run('CREATE INDEX IF NOT EXISTS episodes_by_start ON episodes (chat, topic, first_id)')
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ep_fts USING fts5(text, digest, ekey UNINDEXED, chat UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2')`)
    // Summaries by more than one model can sit side by side, so engines can be
    // compared with and without them. `src` is a hash of the stretch they were
    // written from: a stretch that grew since is due a new one.
    this.db.run(`CREATE TABLE IF NOT EXISTS summaries (ekey TEXT NOT NULL, model TEXT NOT NULL, src TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (ekey, model))`)
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sum_fts USING fts5(summary, ekey UNINDEXED, chat UNINDEXED, model UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2')`)
    // Vectors by "space": an embedding model and what it was given — the stretch
    // (`text`), a summary with the stretch (`haiku+text`), or a summary alone (`haiku`).
    this.db.run(`CREATE TABLE IF NOT EXISTS vecs (ekey TEXT NOT NULL, space TEXT NOT NULL, src TEXT NOT NULL, vec BLOB NOT NULL,
      PRIMARY KEY (ekey, space))`)
    // Photos and files of an imported export, so a reader can open the file itself.
    this.db.run('CREATE TABLE IF NOT EXISTS media (chat TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (chat, id))')
    // What an external engine (context/engines.ts) was last sent, per stretch.
    this.db.run('CREATE TABLE IF NOT EXISTS synced (target TEXT NOT NULL, ekey TEXT NOT NULL, src TEXT NOT NULL, PRIMARY KEY (target, ekey))')
  }

  close(): void { this.db.close() }

  // A model loaded after the index opened (it takes a few seconds); episodes it has
  // no vector for are picked up by the next embedPending().
  useEmbedder(e: Embedder | undefined): void { this.embedder = e; this.vecCache.clear() }

  getMeta(k: string): string | undefined { return (this.db.query('SELECT v FROM meta WHERE k = ?').get(k) as any)?.v }
  setMeta(k: string, v: string): void { this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v) }

  // Add or replace messages (an edit is a replacement). Their topics are marked for
  // re-cutting into episodes, which refresh() does.
  add(msgs: CtxMessage[]): void {
    const up = this.db.prepare(`INSERT INTO msgs (chat, topic, id, t, author, text, reply_to, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat, id) DO UPDATE SET text = excluded.text, author = excluded.author`)
    const delFts = this.db.prepare('DELETE FROM msg_fts WHERE chat = ? AND id = ?')
    const insFts = this.db.prepare('INSERT INTO msg_fts (text, author, chat, id) VALUES (?, ?, ?, ?)')
    const topic = this.db.prepare(`INSERT INTO topics (chat, topic, title, dirty) VALUES (?, ?, ?, 1)
      ON CONFLICT (chat, topic) DO UPDATE SET dirty = 1, title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE topics.title END`)
    this.db.transaction(() => {
      for (const m of msgs) {
        up.run(m.chat, m.topic, m.id, m.t, m.from, m.text, m.replyTo ?? null, m.bot ? 1 : 0)
        delFts.run(m.chat, m.id)
        insFts.run(normalizeText(m.text), m.from, m.chat, m.id)
        topic.run(m.chat, m.topic, m.topicTitle ?? '')
      }
    })()
  }

  // Remove everything before a time (retention), and re-cut what is left.
  pruneBefore(chat: string, t: number): number {
    const gone = this.db.query('SELECT id FROM msgs WHERE chat = ? AND t < ?').all(chat, t) as { id: number }[]
    if (!gone.length) return 0
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM msgs WHERE chat = ? AND t < ?').run(chat, t)
      const del = this.db.prepare('DELETE FROM msg_fts WHERE chat = ? AND id = ?')
      for (const g of gone) del.run(chat, g.id)
      this.db.prepare('UPDATE topics SET dirty = 1 WHERE chat = ?').run(chat)
    })()
    this.refresh()
    return gone.length
  }

  // Re-cut the topics that changed into episodes. An episode whose messages did not
  // change keeps its vector and digest; a new or changed one loses them, and
  // embedPending() / a digest pass fill them in again.
  refresh(): number {
    const dirty = this.db.query('SELECT chat, topic, title FROM topics WHERE dirty = 1').all() as { chat: string; topic: string; title: string }[]
    let changed = 0
    for (const d of dirty) {
      const rows = this.db.query('SELECT id, t, author, text, reply_to, bot FROM msgs WHERE chat = ? AND topic = ? ORDER BY id').all(d.chat, d.topic) as any[]
      const eps = episodesOf(rows.map(r => ({ chat: d.chat, topic: d.topic, topicTitle: d.title, id: r.id, t: r.t, from: r.author, text: r.text, replyTo: r.reply_to ?? undefined, bot: !!r.bot })), this.rules)
      const old = new Map((this.db.query('SELECT ekey, text, digest, vec, vec_model FROM episodes WHERE chat = ? AND topic = ?').all(d.chat, d.topic) as any[]).map(r => [r.ekey, r]))
      this.db.transaction(() => {
        const keep = new Set<string>()
        for (const e of eps) {
          const prev = old.get(e.key)
          keep.add(e.key)
          if (prev && prev.text === e.text) continue
          changed++
          this.db.prepare(`INSERT OR REPLACE INTO episodes (ekey, chat, topic, first_id, last_id, t0, t1, ids, text, digest, vec, vec_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`).run(e.key, e.chat, e.topic, e.first, e.last, e.t0, e.t1, JSON.stringify(e.ids), e.text)
          this.db.prepare('DELETE FROM ep_fts WHERE ekey = ?').run(e.key)
          this.db.prepare('INSERT INTO ep_fts (text, digest, ekey, chat) VALUES (?, ?, ?, ?)').run(normalizeText(e.text), '', e.key, e.chat)
          // Its summaries are now of an older text (kept, but unused until rewritten),
          // and its vectors are of that older text too.
          this.db.prepare('DELETE FROM sum_fts WHERE ekey = ?').run(e.key)
          this.db.prepare('DELETE FROM vecs WHERE ekey = ?').run(e.key)
        }
        for (const k of old.keys()) if (!keep.has(k)) {
          this.db.prepare('DELETE FROM episodes WHERE ekey = ?').run(k)
          this.db.prepare('DELETE FROM ep_fts WHERE ekey = ?').run(k)
          this.db.prepare('DELETE FROM summaries WHERE ekey = ?').run(k)
          this.db.prepare('DELETE FROM sum_fts WHERE ekey = ?').run(k)
          this.db.prepare('DELETE FROM vecs WHERE ekey = ?').run(k)
        }
        this.db.prepare('UPDATE topics SET dirty = 0 WHERE chat = ? AND topic = ?').run(d.chat, d.topic)
      })()
      this.vecCache.delete(d.chat)
      for (const k of [...this.spaceCache.keys()]) if (k.startsWith(`${d.chat}\n`)) this.spaceCache.delete(k)
    }
    if (dirty.length) this.metaCache.clear()
    return changed
  }

  setDigest(ekey: string, digest: string): void {
    this.db.prepare('UPDATE episodes SET digest = ? WHERE ekey = ?').run(digest, ekey)
    const e = this.db.query('SELECT text, chat FROM episodes WHERE ekey = ?').get(ekey) as any
    if (!e) return
    this.db.prepare('DELETE FROM ep_fts WHERE ekey = ?').run(ekey)
    this.db.prepare('INSERT INTO ep_fts (text, digest, ekey, chat) VALUES (?, ?, ?, ?)').run(normalizeText(e.text), normalizeText(digest), ekey, e.chat)
    // A vector made before the digest existed is of the raw text only; redo it.
    this.db.prepare('UPDATE episodes SET vec = NULL, vec_model = NULL WHERE ekey = ?').run(ekey)
    this.vecCache.delete(e.chat)
  }

  episodesNeedingDigest(limit = 50): Episode[] {
    return (this.db.query('SELECT * FROM episodes WHERE digest IS NULL ORDER BY t1 LIMIT ?').all(limit) as any[]).map(rowToEpisode(this))
  }

  // ---- Summaries by model -------------------------------------------------------
  // `text` '-' records that the model had nothing to say, so the stretch is not
  // asked about again.
  setSummary(ekey: string, model: string, text: string): void {
    const e = this.db.query('SELECT text, chat FROM episodes WHERE ekey = ?').get(ekey) as any
    if (!e) return
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO summaries (ekey, model, src, text) VALUES (?, ?, ?, ?)').run(ekey, model, textHash(e.text), text)
      this.db.prepare('DELETE FROM sum_fts WHERE ekey = ? AND model = ?').run(ekey, model)
      if (text && text !== '-') this.db.prepare('INSERT INTO sum_fts (summary, ekey, chat, model) VALUES (?, ?, ?, ?)').run(normalizeText(text), ekey, e.chat, model)
    })()
  }

  // The summary a model wrote of a stretch as it is now; undefined when there is
  // none, or it was written from an older version of the stretch.
  summaryOf(ekey: string, model: string): string | undefined {
    const r = this.db.query('SELECT s.text, s.src, e.text AS etext FROM summaries s JOIN episodes e ON e.ekey = s.ekey WHERE s.ekey = ? AND s.model = ?').get(ekey, model) as any
    return r && r.text !== '-' && r.src === textHash(r.etext) ? r.text : undefined
  }

  // Stretches a model has not summarised as they are now, oldest first.
  // `endedBefore`: only stretches whose last message is older than this (finished talk).
  episodesNeedingSummary(model: string, o: { chat?: string; topics?: Set<string>; skipTopics?: Set<string>; endedBefore?: number; limit?: number } = {}): Episode[] {
    const have = new Map((this.db.query('SELECT ekey, src FROM summaries WHERE model = ?').all(model) as any[]).map(r => [r.ekey, r.src]))
    const rows = (o.chat === undefined ? this.db.query('SELECT * FROM episodes ORDER BY t1').all()
      : this.db.query('SELECT * FROM episodes WHERE chat = ? ORDER BY t1').all(o.chat)) as any[]
    const out: Episode[] = []
    for (const r of rows) {
      if ((o.topics && !o.topics.has(r.topic)) || o.skipTopics?.has(r.topic)) continue
      if (o.endedBefore !== undefined && r.t1 > o.endedBefore) continue
      if (have.get(r.ekey) === textHash(r.text)) continue
      out.push(rowToEpisode(this)(r))
      if (o.limit && out.length >= o.limit) break
    }
    return out
  }

  // ---- Vectors by space ---------------------------------------------------------
  // What a space embeds for one stretch. Undefined while the summary it needs is
  // not written yet.
  spaceInput(variant: string, ekey: string, text: string, maxChars = 2000): string | undefined {
    if (variant === 'text') return passageText(text, undefined, maxChars)
    const plus = variant.endsWith('+text')
    const s = this.summaryOf(ekey, plus ? variant.slice(0, -5) : variant)
    if (!s) return undefined
    return plus ? passageText(text, s, maxChars) : s
  }

  // Embed the stretches a space has no current vector for. Batched, for the
  // background; returns how many it embedded.
  async embedSpace(embedder: Embedder, variant: string, o: { batch?: number; max?: number; chat?: string; maxChars?: number } = {}): Promise<number> {
    const space = `${embedder.name}|${variant}`
    const done = new Map((this.db.query('SELECT ekey, src FROM vecs WHERE space = ?').all(space) as any[]).map(r => [r.ekey, r.src]))
    const rows = (o.chat === undefined ? this.db.query('SELECT ekey, chat, text FROM episodes ORDER BY t1').all()
      : this.db.query('SELECT ekey, chat, text FROM episodes WHERE chat = ? ORDER BY t1').all(o.chat)) as any[]
    const todo: { ekey: string; chat: string; input: string; src: string }[] = []
    for (const r of rows) {
      const input = this.spaceInput(variant, r.ekey, r.text, o.maxChars)
      if (input === undefined) continue
      const src = textHash(input)
      if (done.get(r.ekey) === src) continue
      todo.push({ ekey: r.ekey, chat: r.chat, input, src })
      if (todo.length >= (o.max ?? Infinity)) break
    }
    const batch = o.batch ?? 16
    const ins = this.db.prepare('INSERT OR REPLACE INTO vecs (ekey, space, src, vec) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < todo.length; i += batch) {
      const part = todo.slice(i, i + batch)
      const vs = await embedder.embed(part.map(p => p.input), 'passage')
      this.db.transaction(() => part.forEach((p, j) => ins.run(p.ekey, space, p.src, Buffer.from(vs[j].buffer, vs[j].byteOffset, vs[j].byteLength))))()
      for (const p of part) this.spaceCache.delete(`${p.chat}\n${space}`)
    }
    return todo.length
  }

  private spaceCache = new Map<string, Map<string, Float32Array>>()
  spaceVectors(chat: string, space: string): Map<string, Float32Array> {
    const ck = `${chat}\n${space}`
    let v = this.spaceCache.get(ck)
    if (v) return v
    v = new Map()
    for (const r of this.db.query('SELECT v.ekey, v.vec FROM vecs v JOIN episodes e ON e.ekey = v.ekey WHERE e.chat = ? AND v.space = ?').all(chat, space) as any[]) {
      const b: Uint8Array = r.vec
      v.set(r.ekey, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
    }
    this.spaceCache.set(ck, v)
    return v
  }

  // ---- For engines that rank stretches elsewhere ----------------------------------
  // The messages of a stretch that share words with a query, best first — what the
  // recall block and the tools centre on when a stretch is long.
  matchedIn(chat: string, query: string, ids: number[]): number[] {
    const q = ftsQuery(query)
    if (!q || !ids.length) return []
    const want = new Set(ids)
    const lo = Math.min(...ids), hi = Math.max(...ids)
    return (this.db.query('SELECT id FROM msg_fts WHERE msg_fts MATCH ? AND chat = ? AND id BETWEEN ? AND ? ORDER BY bm25(msg_fts) LIMIT 50').all(q, chat, lo, hi) as { id: number }[])
      .map(r => r.id).filter(id => want.has(id))
  }

  // Hits for stretch keys an engine ranked elsewhere, in its order.
  hitsFor(chat: string, ranked: { key: string; score: number }[], query: string, why: string, o: { k?: number; exclude?: Set<number> } = {}): Hit[] {
    const hits: Hit[] = []
    for (const r of ranked) {
      const e = this.episode(r.key)
      if (!e || e.chat !== chat) continue
      if (o.exclude && e.ids.every(id => o.exclude!.has(id))) continue
      hits.push({ episode: e, score: r.score, why: [why], matched: this.matchedIn(chat, query, e.ids) })
      if (hits.length >= (o.k ?? 5)) break
    }
    return hits
  }

  // ---- Media of imported exports ---------------------------------------------------
  setMedia(chat: string, id: number, kind: string, path: string): void {
    this.db.prepare('INSERT OR REPLACE INTO media (chat, id, kind, path) VALUES (?, ?, ?, ?)').run(chat, id, kind, path)
  }
  mediaOf(chat: string, ids: number[]): Map<number, { kind: string; path: string }> {
    const out = new Map<number, { kind: string; path: string }>()
    if (!ids.length) return out
    const q = this.db.prepare('SELECT kind, path FROM media WHERE chat = ? AND id = ?')
    for (const id of ids) { const r = q.get(chat, id) as any; if (r) out.set(id, { kind: r.kind, path: r.path }) }
    return out
  }

  // Embed episodes that have no vector from the current model. Batched, and meant to
  // run in the background: a few hundred episodes a minute on a small CPU.
  async embedPending(batch = 16, max = Infinity): Promise<number> {
    if (!this.embedder) return 0
    let n = 0
    while (n < max) {
      const rows = this.db.query('SELECT ekey, chat, text, digest FROM episodes WHERE vec IS NULL OR vec_model <> ? LIMIT ?').all(this.embedder.name, batch) as any[]
      if (!rows.length) break
      const vecs = await this.embedder.embed(rows.map(r => passageText(r.text, r.digest)), 'passage')
      this.db.transaction(() => {
        rows.forEach((r, i) => this.db.prepare('UPDATE episodes SET vec = ?, vec_model = ? WHERE ekey = ?').run(Buffer.from(vecs[i].buffer), this.embedder!.name, r.ekey))
      })()
      for (const r of rows) this.vecCache.delete(r.chat)
      n += rows.length
    }
    return n
  }

  private vectors(chat: string): Map<string, Float32Array> {
    let v = this.vecCache.get(chat)
    if (v) return v
    v = new Map()
    for (const r of this.db.query('SELECT ekey, vec FROM episodes WHERE chat = ? AND vec IS NOT NULL AND vec_model = ?').all(chat, this.embedder?.name ?? '') as any[]) {
      const b: Uint8Array = r.vec
      v.set(r.ekey, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
    }
    this.vecCache.set(chat, v)
    return v
  }

  episode(ekey: string): Episode | undefined {
    const r = this.db.query('SELECT * FROM episodes WHERE ekey = ?').get(ekey) as any
    return r ? rowToEpisode(this)(r) : undefined
  }

  // Search one chat. `query` is what to look for, in people's words; `context` is
  // optional surrounding talk (the last few messages), used by the meaning signal
  // only, where a vague question ("what about that?") needs it and keyword search
  // would only be diluted by it.
  // `recent`: the topic being answered in and the first message the turn already
  // has (since its last reply); stretches of that topic from there on are skipped,
  // since the turn has them word for word.
  // `summaries`: also search the summaries one model wrote, as a signal of their own
  // ('with-text'), or search only them in place of the talk ('alone').
  // `meaning`: vectors from a space (see embedSpace) instead of the index's default
  // embedder; false for none.
  // `weights` scales each signal's say in the fusion (words, message, context, when,
  // meaning, summary); a signal left out keeps weight 1, and 0 drops it.
  async search(chat: string, query: string, o: SearchOptions = {}): Promise<Hit[]> {
    const k = o.k ?? 5, pool = o.pool ?? 40
    const inRange = (e: { t0: number; t1: number; topic: string; last?: number }) =>
      (o.topic === undefined || e.topic === o.topic) && (o.since === undefined || e.t1 >= o.since) && (o.until === undefined || e.t0 <= o.until) &&
      !(o.recent && e.topic === o.recent.topic && (e.last ?? 0) >= o.recent.from)
    const lists: { name: string; ids: string[]; weight?: number }[] = []
    const matchedIn = new Map<string, number[]>()
    // A question with barely any words of its own ("can you find what she posted?")
    // is about what was just said: search the two together. Otherwise the question
    // leads, and what was just said is a weaker signal of its own, below.
    const own = ftsQuery(query)
    const vague = !!o.context && own.split(' OR ').filter(Boolean).length <= 3
    const q = vague ? ftsQuery(`${query}\n${o.context}`) : own
    const alone = o.summaries?.use === 'alone'
    if (q && o.summaries) {
      const rows = this.db.query('SELECT ekey FROM sum_fts WHERE sum_fts MATCH ? AND chat = ? AND model = ? ORDER BY bm25(sum_fts) LIMIT ?').all(q, chat, o.summaries.model, pool) as { ekey: string }[]
      lists.push({ name: 'summary', ids: rows.map(r => r.ekey).filter(key => { const e = this.meta(key); return !!e && inRange(e) }) })
    }
    if (q && !alone) {
      // Episodes by their words (and digest, when there is one).
      const eps = this.db.query(`SELECT ekey FROM ep_fts WHERE ep_fts MATCH ? AND chat = ? ORDER BY bm25(ep_fts, 1.0, 1.5) LIMIT ?`).all(q, chat, pool) as { ekey: string }[]
      lists.push({ name: 'words', ids: eps.map(r => r.ekey).filter(key => { const e = this.meta(key); return !!e && inRange(e) }) })
      // Messages by their words, credited to the episode they sit in: a single
      // message that says exactly the thing should not drown in a long episode.
      const ms = this.db.query(`SELECT id FROM msg_fts WHERE msg_fts MATCH ? AND chat = ? ORDER BY bm25(msg_fts) LIMIT ?`).all(q, chat, pool * 2) as { id: number }[]
      const byEp: string[] = []
      for (const m of ms) {
        if (o.exclude?.has(m.id)) continue
        const key = this.episodeOf(chat, m.id)
        if (!key) continue
        const e = this.meta(key)
        if (!e || !inRange(e)) continue
        matchedIn.set(key, [...(matchedIn.get(key) ?? []), m.id])
        if (!byEp.includes(key)) byEp.push(key)
      }
      lists.push({ name: 'message', ids: byEp })
    }
    // What was just said, for a question that leans on it ("what about that?"): its
    // words, at half weight, so they help a vague question without drowning a clear one.
    const cq = o.context && !vague && !alone ? ftsQuery(o.context) : ''
    if (cq) {
      const eps = this.db.query(`SELECT ekey FROM ep_fts WHERE ep_fts MATCH ? AND chat = ? ORDER BY bm25(ep_fts, 1.0, 1.5) LIMIT ?`).all(cq, chat, pool) as { ekey: string }[]
      lists.push({ name: 'context', weight: 0.5, ids: eps.map(r => r.ekey).filter(key => { const e = this.meta(key); return !!e && inRange(e) }) })
    }
    // A time the question names ("last Tuesday", "early July"): what falls in it, in
    // the order the other signals put it, then the rest of that stretch of time.
    // The question's own words decide; a follow-up ("can you find it?") takes the
    // time from what was just said ("she posted it back in July").
    const when = timeWindow(query, o.now ?? Date.now() / 1000) ?? (o.context ? timeWindow(o.context, o.now ?? Date.now() / 1000) : undefined)
    if (when) {
      const inWhen = (key: string) => { const e = this.meta(key); return !!e && inRange(e) && e.t1 >= when.since && e.t0 <= when.until }
      const ranked = [...new Set(lists.flatMap(l => l.ids))].filter(inWhen)
      const rest = (this.db.query('SELECT ekey FROM episodes WHERE chat = ? AND t1 >= ? AND t0 <= ? ORDER BY t0').all(chat, when.since, when.until) as { ekey: string }[])
        .map(r => r.ekey).filter(key => inWhen(key) && !ranked.includes(key))
      lists.push({ name: 'when', ids: [...ranked, ...rest].slice(0, pool) })
    }
    const embedder = o.meaning === false ? undefined : o.meaning ? o.meaning.embedder : this.embedder
    if (embedder) {
      // Meaning of the talk itself (not when only summaries are searched), and of the
      // summaries, as two signals of their own.
      const spaces: { name: string; vecs: Map<string, Float32Array> }[] = []
      if (!alone) spaces.push({ name: 'meaning', vecs: o.meaning ? this.spaceVectors(chat, `${o.meaning.embedder.name}|text`) : this.vectors(chat) })
      if (o.summaries && o.meaning) spaces.push({ name: 'summary meaning', vecs: this.spaceVectors(chat, `${o.meaning.embedder.name}|${o.summaries.model}`) })
      // An embeddings server that is down costs the meaning signal, not the search.
      const qv = spaces.some(s => s.vecs.size) ? await embedder.embed([o.context ? `${query}\n${o.context}` : query], 'query')
        .then(v => v[0], e => { console.error(`[ctx] meaning search skipped: ${e}`); return undefined }) : undefined
      if (qv) for (const s of spaces) {
        const scored: [string, number][] = []
        for (const [key, v] of s.vecs) {
          const e = this.meta(key)
          if (!e || !inRange(e)) continue
          scored.push([key, cosine(qv, v)])
        }
        scored.sort((a, b) => b[1] - a[1])
        lists.push({ name: s.name, ids: scored.slice(0, pool).map(x => x[0]) })
      }
    }
    const weighted = lists.map(l => ({ ...l, weight: (l.weight ?? 1) * (o.weights?.[l.name] ?? 1) })).filter(l => l.weight > 0)
    const fused = [...rrf(weighted).entries()].sort((a, b) => b[1].score - a[1].score)
    const hits: Hit[] = []
    for (const [key, f] of fused) {
      const e = this.episode(key)
      if (!e) continue
      if (o.exclude && e.ids.every(id => o.exclude!.has(id))) continue
      hits.push({ episode: e, score: f.score, why: f.why, matched: matchedIn.get(key) ?? [] })
      if (hits.length >= k) break
    }
    return hits
  }

  private metaCache = new Map<string, { t0: number; t1: number; topic: string; last: number } | null>()
  private meta(key: string): { t0: number; t1: number; topic: string; last: number } | undefined {
    if (!this.metaCache.has(key)) this.metaCache.set(key, (this.db.query('SELECT t0, t1, topic, last_id AS last FROM episodes WHERE ekey = ?').get(key) as any) ?? null)
    return this.metaCache.get(key) ?? undefined
  }
  // The stretch a message is in: the last one of its topic starting at or before it
  // (an index lookup; scanning every stretch per matched message cost a keyword
  // search a quarter of a second on a 16k-message history).
  private episodeOf(chat: string, id: number): string | undefined {
    const m = this.db.query('SELECT topic FROM msgs WHERE chat = ? AND id = ?').get(chat, id) as { topic: string } | null
    if (!m) return undefined
    const r = this.db.query('SELECT ekey, last_id FROM episodes WHERE chat = ? AND topic = ? AND first_id <= ? ORDER BY first_id DESC LIMIT 1')
      .get(chat, m.topic, id) as { ekey: string; last_id: number } | null
    return r && r.last_id >= id ? r.ekey : undefined
  }

  // The names a message may use to point at the group's past: the people who have
  // spoken, and the group's own proper names — words written capitalised in the
  // middle of sentences in at least two messages ("Operation Elephant", "Relief
  // Grid", "Kessler"). Cached per chat for ten minutes.
  private namesCache = new Map<string, { at: number; names: string[] }>()
  people(chat: string): string[] {
    const c = this.namesCache.get(chat)
    if (c && Date.now() - c.at < 600_000) return c.names
    const people = (this.db.query('SELECT DISTINCT author FROM msgs WHERE chat = ? AND bot = 0').all(chat) as { author: string }[])
      .flatMap(r => [r.author, r.author.split(/\s+/)[0]])
    // A proper name is written capitalised and never in lower case: "Elephant" as a
    // project's name is, "Open" or "Team" are not. Acronyms (CSV, API) are too
    // generic to point at anything.
    const counts = new Map<string, number>(), lower = new Set<string>()
    for (const r of this.db.query('SELECT text FROM msgs WHERE chat = ?').all(chat) as { text: string }[]) {
      const seen = new Set<string>()
      for (const m of r.text.matchAll(/(?<=[\p{L}\p{N},;:)]\s+)[A-Z][\p{Ll}\p{N}][\p{L}\p{N}]+/gu)) seen.add(m[0])
      for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1)
      for (const m of r.text.matchAll(/(?<![\p{L}\p{N}])[\p{Ll}][\p{Ll}\p{N}]{2,}/gu)) lower.add(m[0])
    }
    for (const w of [...counts.keys()]) if (lower.has(w.toLowerCase())) counts.delete(w)
    const common = new Set(['The', 'This', 'That', 'And', 'But', 'For', 'Yes', 'Not', 'Can', 'Will', 'Just', 'Also', 'Maybe', 'Thanks', 'Monday', 'Tuesday',
      'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
      'October', 'November', 'December', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'I\'m', 'I\'ll', 'OK', 'Okay'])
    const named = [...counts.entries()].filter(([w, n]) => n >= 2 && !common.has(w)).map(([w]) => w)
    const names = [...new Set([...people, ...named])].filter(n => n.length >= 3)
    this.namesCache.set(chat, { at: Date.now(), names })
    return names
  }

  // The words a chat writes in Latin letters most often — product, company, project
  // and people's names and the jargon around them — by how many messages use them.
  // The recall's query writer (query.ts) is shown them, so a name typed in another
  // script comes out spelled the way the chat itself spells it. Cached
  // for an hour per chat.
  private vocabCache = new Map<string, { at: number; words: string[] }>()
  vocabulary(chat: string, max = 120): string[] {
    const c = this.vocabCache.get(chat)
    if (c && Date.now() - c.at < 3600_000) return c.words.slice(0, max)
    const df = new Map<string, number>()
    for (const r of this.db.query('SELECT text FROM msgs WHERE chat = ? AND bot = 0').all(chat) as { text: string }[]) {
      const seen = new Set<string>()
      for (const m of r.text.replace(/https?:\/\/\S+/g, ' ').matchAll(/(?<![\p{L}\p{N}])[A-Za-z][A-Za-z.-]{2,24}(?![\p{L}\p{N}])/gu)) {
        const w = m[0].toLowerCase().replace(/[.-]+$/, '')
        if (w.length >= 3 && !STOP.has(w) && !COMMON_EN.has(w)) seen.add(w)
      }
      for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1)
    }
    const words = [...df.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 400).map(([w]) => w)
    this.vocabCache.set(chat, { at: Date.now(), words })
    return words.slice(0, max)
  }

  stats(chat?: string): { messages: number; episodes: number; vectors: number; digests: number } {
    const w = chat === undefined ? '' : ' WHERE chat = ?'
    const a = chat === undefined ? [] : [chat]
    return {
      messages: (this.db.query(`SELECT count(*) n FROM msgs${w}`).get(...a) as any).n,
      episodes: (this.db.query(`SELECT count(*) n FROM episodes${w}`).get(...a) as any).n,
      vectors: (this.db.query(`SELECT count(*) n FROM episodes${w ? w + ' AND' : ' WHERE'} vec IS NOT NULL`).get(...a) as any).n,
      digests: (this.db.query(`SELECT count(*) n FROM episodes${w ? w + ' AND' : ' WHERE'} digest IS NOT NULL`).get(...a) as any).n,
    }
  }
}

// What an episode is embedded as: its digest first when it has one (the ideas in
// plain words), then the talk itself, cut to what small models read anyway.
export function passageText(text: string, digest?: string | null, maxChars = 2000): string {
  const body = digest ? `${digest}\n${text}` : text
  return body.length > maxChars ? body.slice(0, maxChars) : body
}

// A short, stable fingerprint of a text: whether a summary or a vector was made from
// the text as it is now.
export function textHash(s: string): string {
  return Bun.hash(s).toString(36)
}

function rowToEpisode(idx: ContextIndex) {
  return (r: any): Episode => {
    const t = idx.db.query('SELECT title FROM topics WHERE chat = ? AND topic = ?').get(r.chat, r.topic) as any
    return { key: r.ekey, chat: r.chat, topic: r.topic, topicTitle: t?.title || (r.topic === 'main' ? 'General' : `topic ${r.topic}`),
      first: r.first_id, last: r.last_id, t0: r.t0, t1: r.t1, ids: JSON.parse(r.ids), text: r.text }
  }
}
