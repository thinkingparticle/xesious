#!/usr/bin/env bun
// Write a digest for every episode of the synthetic chat, with the same prompt the
// engine uses (context/digest.ts), through the Claude CLI.
//
//   bun research/context/digests.ts --model haiku --conc 4
//
// Output: research/context/digests-<model>.json, { episodeKey: digest }. Reruns keep
// what is already there, so an interrupted run resumes.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ContextIndex, type CtxMessage } from '../../context/engine'
import { DIGEST_SYSTEM, digestUser, cleanDigest } from '../../context/digest'

const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const model = arg('model', 'haiku')!
// --local http://127.0.0.1:8090/v1: an OpenAI-compatible local server instead of the
// Claude CLI (then --model is the server's model name).
const local = arg('local')
const conc = Number(arg('conc', '4'))
const out = arg('out', join(import.meta.dir, `digests-${model}.json`))!
const cwd = arg('cwd', '/tmp')!
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')
const rows = readFileSync(join(import.meta.dir, 'chat.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const msgs: CtxMessage[] = rows.map((r: any) => ({ chat: '-1', topic: slug(r.topic), topicTitle: r.topic, id: r.id, t: Math.floor(Date.parse(r.t) / 1000), from: r.from, text: r.text, replyTo: r.reply_to ?? undefined }))
const idx = new ContextIndex(':memory:')
idx.add(msgs); idx.refresh()
const eps = idx.episodesNeedingDigest(10_000)
const done: Record<string, string> = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
// --keys <episodes.json>: only the stretches listed there (e.g. a reduced benchmark set).
const keysFile = arg('keys')
const only = keysFile ? new Set((JSON.parse(readFileSync(keysFile, 'utf8')) as { key: string }[]).map(e => e.key)) : undefined
const todo = eps.filter(e => !done[e.key] && (!only || only.has(e.key)))
console.error(`${eps.length} episodes, ${todo.length} to digest with ${model}`)

let cost = 0, inTok = 0, n = 0
async function callLocal(user: string): Promise<string> {
  try {
    const r = await fetch(`${local!.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 300, messages: [{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: user }] }) })
    const d: any = await r.json()
    inTok += d.usage?.prompt_tokens ?? 0
    return String(d.choices?.[0]?.message?.content ?? '')
  } catch { return '' }
}
function call(user: string): Promise<string> {
  if (local) return callLocal(user)
  return new Promise(resolve => {
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('TG_') || k.startsWith('TELEGRAM_')) delete env[k]
    const p = spawn('claude', ['-p', user, '--model', model, '--system-prompt', DIGEST_SYSTEM, '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', '--settings', '{"alwaysThinkingEnabled":false}'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    p.stdout.on('data', d => o += d)
    p.on('close', () => {
      try { const d = JSON.parse(o); cost += d.total_cost_usd ?? 0; inTok += d.usage?.input_tokens ?? 0; resolve(String(d.result ?? '')) } catch { resolve('') }
    })
  })
}
let next = 0
const t0 = performance.now()
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < todo.length) {
    const e = todo[next++]
    const d = cleanDigest(await call(digestUser(e)))
    if (d) done[e.key] = d
    n++
    if (n % 10 === 0) { writeFileSync(out, JSON.stringify(done, null, 1)); console.error(`${n}/${todo.length}`) }
  }
}))
writeFileSync(out, JSON.stringify(done, null, 1))
console.log(`digested ${n} episodes in ${Math.round((performance.now() - t0) / 1000)}s; list-price cost $${cost.toFixed(3)}, avg input ${Math.round(inTok / Math.max(1, n))} tokens → ${out}`)
