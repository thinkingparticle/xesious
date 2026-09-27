#!/usr/bin/env bun
// End to end: can Claude answer "what happened with that thing…" using only the
// history tools (context/mcp.ts) over the synthetic chat?
//
//   bun research/context/agentic.ts --model haiku --conc 3 [--limit 20] [--digests research/context/digests-haiku.json] [--recall]
//
// Each question runs `claude -p` with no built-in tools, only the three history
// tools, from a directory outside any repository. The model answers and lists the
// message ids it relied on; a question counts as found when one of them is a gold
// message. --recall also hands it the engine's automatic recall block first, the
// way the bridge does on a mention.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextIndex, recallPick, type CtxMessage } from '../../context/engine'

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const has = (k: string) => argv.includes(`--${k}`)
const model = arg('model', 'haiku')!
const conc = Number(arg('conc', '3'))
const limit = Number(arg('limit', '0'))
const digestFile = arg('digests')
const withRecall = has('recall')
const cwd = arg('cwd', '/tmp')!
const dir = import.meta.dir

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')
const rows = readFileSync(join(dir, 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const msgs: CtxMessage[] = rows.map((r: any) => ({ chat: '-1', topic: slug(r.topic), topicTitle: r.topic, id: r.id, t: Math.floor(Date.parse(r.t) / 1000), from: r.from, text: r.text, replyTo: r.reply_to ?? undefined }))
const byId = new Map(msgs.map(m => [m.id, m]))
let queries = readFileSync(join(dir, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
if (limit) queries = queries.slice(0, limit)

const DB = join(mkdtempSync(join(tmpdir(), 'xesious-agentic-')), 'context.db')
const idx = new ContextIndex(DB)
idx.add(msgs); idx.refresh()
if (digestFile && existsSync(digestFile)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(digestFile, 'utf8')) as Record<string, string>)) if (idx.episode(k)) idx.setDigest(k, v)

const mcp = JSON.stringify({ mcpServers: { history: { command: process.execPath, args: [join(dir, '..', '..', 'context', 'mcp.ts')], env: { XESIOUS_CONTEXT_DB: DB, XESIOUS_CONTEXT_CHAT: '-1' } } } })
const SYSTEM = `You are Scout, an AI assistant in a small company's group chat on Telegram. You have tools to search the group's past conversations. ` +
  `When someone refers to something discussed earlier, find it before answering. Answer in one to three sentences. ` +
  `Then, on the last line, write SOURCES: followed by the message ids (like #123) you relied on.`

async function recallText(q: any): Promise<string> {
  const recentFrom = q.recent?.length ? Math.min(...q.recent) : undefined
  const hits = await idx.search('-1', String(q.question).replace(/@\w+/g, ''), { k: 8, context: (q.recent ?? []).map((id: number) => byId.get(id)?.text ?? '').join('\n') || undefined,
    now: Math.floor(Date.parse(q.t) / 1000), recent: recentFrom !== undefined ? { topic: slug(q.topic), from: recentFrom } : undefined })
  // The bridge's own rule, so this measures what a mention is really handed.
  const strong = recallPick(hits, `${q.question}\n${(q.recent ?? []).map((id: number) => byId.get(id)?.text ?? '').join('\n')}`, { names: idx.people('-1'), now: Math.floor(Date.parse(q.t) / 1000) })
  if (!strong.length) return ''
  return 'Earlier conversations in this group that may be what this message is about (may be unrelated):\n' +
    strong.map(h => `— ${h.episode.topicTitle}, ${new Date(h.episode.t0 * 1000).toISOString().slice(0, 10)}:\n${h.episode.text.split('\n').slice(1).join('\n')}`).join('\n\n') + '\n\n'
}

function ask(prompt: string): Promise<{ text: string; cost: number; turns: number; ms: number }> {
  const t0 = performance.now()
  return new Promise(resolve => {
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('TG_') || k.startsWith('TELEGRAM_')) delete env[k]
    const p = spawn('claude', ['-p', prompt, '--model', model, '--system-prompt', SYSTEM, '--tools', '', '--mcp-config', mcp, '--strict-mcp-config',
      '--allowedTools', 'mcp__history__search_history,mcp__history__read_messages,mcp__history__list_topics',
      '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--settings', '{"alwaysThinkingEnabled":false}'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    p.stdout.on('data', d => o += d)
    p.on('close', () => {
      try { const d = JSON.parse(o); resolve({ text: String(d.result ?? ''), cost: d.total_cost_usd ?? 0, turns: d.num_turns ?? 0, ms: performance.now() - t0 }) }
      catch { resolve({ text: '', cost: 0, turns: 0, ms: performance.now() - t0 }) }
    })
  })
}

type R = { id: string; type: string; found: boolean; cited: number[]; answer: string; gold: string; cost: number; turns: number; ms: number }
const results: R[] = []
let next = 0
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < queries.length) {
    const q = queries[next++]
    const recent = (q.recent ?? []).map((id: number) => { const m = byId.get(id); return m ? `[${m.from}]: ${m.text}` : '' }).filter(Boolean).join('\n')
    const prompt = (withRecall ? await recallText(q) : '') +
      `Topic: ${q.topic}. Today is ${String(q.t).slice(0, 10)}.\n` + (recent ? `The last messages in this topic:\n${recent}\n\n` : '') +
      `${q.from} asks you: ${q.question}`
    const r = await ask(prompt)
    const cited = [...(r.text.split(/SOURCES:/i).pop() ?? '').matchAll(/#?(\d{1,5})/g)].map(m => Number(m[1]))
    const found = cited.some(id => q.gold.includes(id))
    results.push({ id: q.id, type: q.type, found, cited, answer: r.text.split(/SOURCES:/i)[0].trim(), gold: q.answer, cost: r.cost, turns: r.turns, ms: r.ms })
    process.stderr.write(`${q.id} ${q.type.padEnd(16)} ${found ? 'found' : 'MISS '} turns=${r.turns} ${Math.round(r.ms / 1000)}s ${JSON.stringify(r.text.slice(0, 80))}\n`)
  }
}))
results.sort((a, b) => a.id.localeCompare(b.id))
const pct = (x: number) => `${(100 * x).toFixed(0)}%`
const types = [...new Set(results.map(r => r.type))].sort()
const cost = results.reduce((s, r) => s + r.cost, 0)
console.log(`== agentic, ${model}${withRecall ? ' + recall block' : ''}${digestFile ? ' + digests' : ''}: ${results.length} questions`)
console.log(`cited a gold message: ${pct(results.filter(r => r.found).length / results.length)}; avg ${(results.reduce((s, r) => s + r.turns, 0) / results.length).toFixed(1)} turns, ${Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length / 1000)}s; list-price cost $${cost.toFixed(3)} ($${(cost / results.length).toFixed(4)}/question)`)
console.log('by type: ' + types.map(t => { const rs = results.filter(r => r.type === t); return `${t} ${rs.filter(r => r.found).length}/${rs.length}` }).join('  '))
writeFileSync(join(dir, `agentic-${model}${withRecall ? '-recall' : ''}${digestFile ? '-digests' : ''}.json`), JSON.stringify(results, null, 1))
idx.close()
