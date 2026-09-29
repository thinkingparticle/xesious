#!/usr/bin/env bun
// Benchmark the context engine's retrieval on a synthetic group chat.
//
//   bun research/context/bench.ts                         # keywords only
//   bun research/context/bench.ts --embed Xenova/multilingual-e5-small
//   bun research/context/bench.ts --embed … --digests research/context/digests-haiku.json
//
// For each question in queries.jsonl the engine returns its top episodes; a question
// counts as answered at k when an episode among the first k holds one of its gold
// messages. Also reported: how many of the gold messages the top 5 cover (a question
// often needs more than one), MRR, and the result by question type.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ContextIndex, recallPick, type CtxMessage } from '../../context/engine'
import { localEmbedder, httpEmbedder } from '../../context/embed'

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const has = (k: string) => argv.includes(`--${k}`)
const dir = import.meta.dir
const chatFile = arg('chat', join(dir, 'chat.jsonl'))!
const queryFile = arg('queries', join(dir, 'queries.jsonl'))!
const embedModel = arg('embed')
const digestFile = arg('digests')
const withContext = !has('no-context')
const depsDir = arg('deps')
const cacheDir = arg('cache', process.env.HF_CACHE)
// How the signals are fused (context/engine.ts FusionOpts), as JSON: --fusion '{"k":10}'
const fusion = arg('fusion') ? JSON.parse(arg('fusion')!) : undefined

const CHAT = '-1'
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')
const rows = readFileSync(chatFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const msgs: CtxMessage[] = rows.map((r: any) => ({
  chat: CHAT, topic: slug(r.topic), topicTitle: r.topic, id: r.id, t: Math.floor(Date.parse(r.t) / 1000), from: r.from, text: r.text,
  replyTo: r.reply_to ?? undefined, bot: r.from === 'Scout',
}))
const byId = new Map(msgs.map(m => [m.id, m]))
const queries = readFileSync(queryFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

const t0 = performance.now()
const embedUrl = arg('embed-url')
const embedder = embedUrl ? httpEmbedder(embedUrl, embedModel ?? 'default') : embedModel ? await localEmbedder({ model: embedModel, depsDir, cacheDir }) : undefined
if (embedModel && !embedder) { console.error(`could not load ${embedModel}`); process.exit(1) }
// Episode rules, to compare segmentations: --min-msgs 1 cuts at every pause.
const rules = { ...(arg('min-msgs') ? { minMsgs: Number(arg('min-msgs')) } : {}), ...(arg('hard-gap-h') ? { hardGap: Number(arg('hard-gap-h')) * 3600 } : {}) }
const idx = new ContextIndex(':memory:', embedder, rules)
idx.add(msgs)
idx.refresh()
if (digestFile && existsSync(digestFile)) {
  const d = JSON.parse(readFileSync(digestFile, 'utf8')) as Record<string, string>
  let n = 0
  for (const [k, v] of Object.entries(d)) { if (idx.episode(k)) { idx.setDigest(k, v); n++ } }
  console.error(`digests applied: ${n}/${idx.stats().episodes}`)
}
const tIdx = performance.now()
const embedded = await idx.embedPending(16)
const tEmb = performance.now()
const st = idx.stats()

// What the bridge would actually hand over: recallPick, the rule recallBlock in
// bridge.ts uses, over the question and the talk just before it.
const people = idx.people(CHAT)
const strongOf = (hits: Awaited<ReturnType<typeof idx.search>>, text: string, now: number) => recallPick(hits, text, { names: people, now })
type R = { id: string; type: string; rank: number; cover5: number; ms: number; block: number; blockHit: boolean }
const results: R[] = []
for (const q of queries) {
  const question = String(q.question).replace(/@\w+/g, '').trim()
  const context = withContext && q.recent?.length ? q.recent.map((id: number) => byId.get(id)?.text ?? '').join('\n') : undefined
  const exclude = new Set<number>(q.recent ?? [])
  const s0 = performance.now()
  // As the bridge does: the topic's own recent talk is already in the turn.
  const recentFrom = q.recent?.length ? Math.min(...q.recent) : undefined
  const hits = await idx.search(CHAT, question, { k: 10, context, exclude, fusion, now: Math.floor(Date.parse(q.t) / 1000),
    recent: recentFrom !== undefined ? { topic: slug(q.topic), from: recentFrom } : undefined })
  const ms = performance.now() - s0
  const gold = new Set<number>(q.gold)
  const rank = hits.findIndex(h => h.episode.ids.some(id => gold.has(id))) + 1
  const top5 = new Set(hits.slice(0, 5).flatMap(h => h.episode.ids))
  const cover5 = [...gold].filter(id => top5.has(id)).length / gold.size
  const block = strongOf(hits, question + (context ? `\n${context}` : ''), Math.floor(Date.parse(q.t) / 1000))
  results.push({ id: q.id, type: q.type, rank, cover5, ms, block: block.length, blockHit: block.some(h => h.episode.ids.some(id => gold.has(id))) })
  if (has('verbose')) console.error(`${q.id} ${q.type.padEnd(16)} rank=${rank || '-'} cover5=${cover5.toFixed(2)} ${JSON.stringify(question).slice(0, 70)}`)
}

const at = (rs: R[], k: number) => rs.filter(r => r.rank > 0 && r.rank <= k).length / rs.length
const mrr = (rs: R[]) => rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length
const pct = (x: number) => `${(100 * x).toFixed(0)}%`
const types = [...new Set(results.map(r => r.type))].sort()
const name = `${embedModel ?? 'keywords only'}${digestFile ? ' + digests' : ''}${fusion ? ` fusion ${JSON.stringify(fusion)}` : ''}${withContext ? '' : ' (no recent context)'}${Object.keys(rules).length ? ` ${JSON.stringify(rules)}` : ''}`
console.log(`== ${name}`)
console.log(`${st.messages} messages, ${st.episodes} episodes; index ${Math.round(tIdx - t0)}ms, embedded ${embedded} in ${Math.round(tEmb - tIdx)}ms; search p50 ${Math.round(results.map(r => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)])}ms`)
console.log(`hit@1 ${pct(at(results, 1))}  hit@3 ${pct(at(results, 3))}  hit@5 ${pct(at(results, 5))}  hit@10 ${pct(at(results, 10))}  MRR ${mrr(results).toFixed(2)}  gold covered by top 5: ${pct(results.reduce((s, r) => s + r.cover5, 0) / results.length)}`)
console.log('by type (hit@5): ' + types.map(t => { const rs = results.filter(r => r.type === t); return `${t} ${rs.filter(r => r.rank > 0 && r.rank <= 5).length}/${rs.length}` }).join('  '))
console.log('missed at 5: ' + results.filter(r => !(r.rank > 0 && r.rank <= 5)).map(r => `${r.id}(${r.type})`).join(' '))
// Questions that are not about the group's past at all: the block should stay empty.
const unrelated = ['can you write a regex that matches email addresses?', 'what is the capital of Australia?', 'translate "good morning" into German please',
  'how do I undo my last git commit?', 'what time is it in Tokyo right now?', 'write a haiku about Mondays', 'can you explain what a race condition is?',
  'چطوری یه فایل CSV رو تو پایتون بخونم؟', 'give me three name ideas for a cat', 'how many days until Christmas?']
let noise = 0, noisy = 0
const uNow = Date.parse('2026-08-20T10:00:00Z') / 1000
for (const u of unrelated) { const b = strongOf(await idx.search(CHAT, u, { k: 10, now: uNow, fusion }), u, uNow); noise += b.length; if (b.length) noisy++ }
const withBlock = results.filter(r => r.block > 0)
console.log(`recall block (what a mention is handed): answer in it for ${pct(results.filter(r => r.blockHit).length / results.length)} of questions; ` +
  `${(results.reduce((s, r) => s + r.block, 0) / results.length).toFixed(1)} stretches on average; empty for ${results.length - withBlock.length}; ` +
  `on ${unrelated.length} unrelated questions it attached something ${noisy} times (${noise} stretches)`)
