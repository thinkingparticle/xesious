# Context engine — what was built, and how well it finds things

*2026-09-25, branch `feat/context-engine` (forked from `feat/group-use`). The research notes behind the choices are in [landscape.md](landscape.md).*

## The short version

- **OpenViking is out.** Its server moved from Apache-2.0 to **AGPL-3.0** on 2026-03-30. It is also a heavy Python service, its memory extraction fails on local 7B models, and nobody has reproduced its benchmark numbers. Its ideas were kept: tiered summaries, and a filesystem-like layout the model can browse.
- **The winner for a group chat is a small layer of our own on `bun:sqlite`.** On the only multi-party memory benchmark (GroupMemBench, May 2026), plain BM25 scored 43.2% against 46.0% for the best memory system and 25.7% for Mem0. The measurements below agree: keywords get most of the way, and cheap extras close the gap.
- **Built, tested and measured here.** It has no server and no GPU, and needs nothing beyond Bun unless meaning search is wanted. Every licence involved allows commercial use.
  1. **An index** (`state/context.db`) over every recorded topic log, cut into stretches of conversation. It uses FTS5 keyword search with Persian spelling normalised, plus signals for the talk just before a question and for dates like "last Tuesday".
  2. **Optional digests.** Haiku writes a few lines per finished stretch. For the whole test chat that cost $0.17 at list price.
  3. **Optional meaning search** with a small local embedding model: in-process through transformers.js, or through any embeddings server such as llama.cpp.
  4. **Automatic recall.** A mention that points back at something gets up to three earlier stretches, from any topic of the same group.
  5. **Three history tools for Claude over MCP**: search, read around a message, and list topics. They are pinned to that one group.
- **Result.** Keywords alone put the right stretch in the top 5 for 71% of 45 "what happened with that thing…" questions. Haiku digests or a local bge-m3 model each raise that to 82%, and 89% make the top 10. With the tools, digests and the recall block as shipped, Claude Haiku cited a correct source message for **87%** of them. That took 2.3 turns and 6 s on average, at $0.008 per question list price. The bot itself runs on a stronger model, so this is a floor.

## What was built

| Piece | File | Notes |
|---|---|---|
| Index and search | `context/engine.ts` | Messages and stretches are stored in SQLite with FTS5, using the porter + unicode61 tokenizer and Persian normalisation. Ranking fuses words, single messages, the recent talk and dates by reciprocal rank, plus meaning when there is an embedder. Search is scoped to one chat. Edits replace messages, retention prunes them, and the index rebuilds from the logs at startup. |
| Digests | `context/digest.ts` | One `claude -p` call per stretch once it has been quiet for 30 minutes (`TG_CONTEXT_DIGEST=haiku`). The call uses no tools, no MCP, no session file and no repository. |
| Meaning | `context/embed.ts`, `context/setup.sh` | transformers.js in-process (`TG_CONTEXT_EMBED=1`), or an OpenAI-compatible embeddings server (`TG_CONTEXT_EMBED_URL`). |
| Tools for Claude | `context/mcp.ts` | A dependency-free MCP stdio server started per turn by the CLI. It exposes `search_history`, `read_messages` and `list_topics`, and defuses forged bridge markers. |
| Bridge wiring | `bridge.ts` | See the list below. |
| Setting | `lib.ts` | **Recall earlier talk** under More settings, on by default. |
| Tests | `context/*.test.ts`, `test/bridge.e2e.test.ts` | 19 unit tests, including a real MCP session over stdio, and 5 e2e tests. |

What the bridge does with it:

- Recorded messages go into the index as they arrive.
- The recall block goes in front of a group mention, before the conversation block.
- `--mcp-config` and the allowed tools are passed on every group turn. DMs get neither.
- Background ticks do the embedding and write the digests.
- Retention also prunes the index.

**Why stretches and not single messages.** "Yes, let's do that" means nothing on its own. A stretch ends after 45 minutes of quiet once it has 8 messages, and after 12 hours of quiet in any case. This lets a slow topic's trickle of messages stay one discussion; cutting at every pause gave a median stretch of 2 messages.

## How it was measured

The test data is `chat.jsonl` and `queries.jsonl`, written for this:

- **The chat:** a 7-week history of a 7-person startup: 630 messages across 5 topics, 11% in Persian, 5% from the bot. It has renamed ideas ("the Friday thing" = "demo day" = Maryam's show-and-tell), look-alike pairs (two migrations, two discounts), decisions that changed twice (a grant deadline), and passing mentions that mattered later.
- **The questions:** 45, with gold message ids, across 10 types.

Both were written by a Claude agent, so wording habits may favour Claude-based methods. The real test is the team's own chat.

**The metric.** A question is *hit at k* when one of the first k stretches returned contains a gold message. *Recall block* is what a mention is actually handed after the gate below.

| Setup (all on this 4-core box) | hit@1 | hit@3 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|---|
| Keywords, first version | 31% | 47% | 60% | 69% | 0.42 |
| Keywords + recent talk + dates (shipped) | 36% | 60% | 71% | 82% | 0.50 |
| … + Haiku digests | 36% | 62% | 82% | 87% | 0.52 |
| … + multilingual-e5-small (MIT, in-process), no digests | 42% | 67% | 78% | 84% | 0.57 |
| … + multilingual-e5-small + digests | 42% | 69% | **84%** | **89%** | 0.59 |
| … + bge-m3 (MIT, llama-server), no digests | 49% | 76% | 82% | 89% | **0.63** |
| … + bge-m3 + digests | 49% | 71% | 82% | 87% | 0.62 |
| … + EmbeddingGemma-300m (Gemma terms, llama-server), no digests | 44% | 76% | 80% | 84% | 0.60 |
| … + EmbeddingGemma-300m + digests | 47% | **80%** | 80% | **89%** | 0.62 |

**Search speed.** Keywords take 2–6 ms per search. A query embedding adds about 15–45 ms with e5-small in-process, and about 110–150 ms with bge-m3 through llama-server. Embedding all 163 stretches, once and in the background, took 25–45 s with e5-small and 100 s with bge-m3 (237 s with the digests prepended), with the box busy. Every row lands between 80% and 89% at hit@10. What separates them is how often the right stretch comes *first*: bge-m3 does that best (MRR 0.63) and keywords alone worst (0.50).

**By type**, for keywords + digests at hit@5:

| Type | Found |
|---|---|
| cross-topic | 4/4 |
| latest state | 5/5 |
| Persian | 4/4 |
| follow-up | 5/5 |
| who-said | 4/4 |
| vague | 4/4 |
| dates | 4/5 |
| look-alike | 4/5 |
| renamed (alias) | 2/5 |
| paraphrase | 1/4 |

Aliases and paraphrases are what meaning search and the model's own searching are for.

### The recall block, and why it is gated

Without a gate, the block went out with every message. For 9 of 10 questions that had nothing to do with the past ("write a regex for emails"), three stretches of old talk that merely shared a word were attached. The gate (`refersBack`) attaches the block only when the message points back at something. It looks for:

- a phrase like "that…", "again", "did we", "who suggested", "what happened", "any news";
- a date;
- a group member's name;
- one of the group's own proper names (words written capitalised mid-sentence and never in lower case, such as "Elephant" or "Relief Grid");
- or the Persian equivalents.

| Recall block | Answer in it | Noise on 10 unrelated questions |
|---|---|---|
| No gate | 60% | 9 of 10 |
| Gate, keywords + digests | 51% | 1 of 10 |
| Gate, e5-small + digests | 56% | 1 of 10 |
| Gate, bge-m3 | 62% | 1 of 10 |
| Gate, EmbeddingGemma | 64% | 1 of 10 |
| Gate, EmbeddingGemma + digests | **67%** | 1 of 10 |

The rest is left to the model's own searching:

| Claude Haiku answering, with the history tools | Cited a gold message | Turns | Time | Cost / question (list) |
|---|---|---|---|---|
| Tools only | 80% | 2.7 | 8 s | $0.0081 |
| Tools + recall block (ungated) + digests | 89% | 2.1 | 7 s | $0.0063 |
| **Tools + recall block (gated, as shipped) + digests** | **87%** | 2.3 | 6 s | $0.0076 |

"Cited a gold message" is strict. Several misses found the right thing but cited a neighbouring message: q40 named the expired-card outage, and q17 listed all three deadlines.

## What it costs to run

- **Keywords:** nothing. The index is a few MB per 10k messages in SQLite; it is derived data and safe to delete.
- **Digests:** one Haiku call per finished stretch, about 650 input tokens, roughly $0.001 at list price. A group writing 500 messages a day makes perhaps 20–40 stretches a day.
- **Meaning:**
  - *In-process:* transformers.js with ONNX Runtime uses about 60 MB of it on Linux (the package ships all platforms, ~490 MB on disk), and e5-small is a 118 MB download. ONNX Runtime has crash fixes that landed in Bun 1.4.0, and this box runs Bun 1.3.14. It worked in every run here, but the separate-process option exists for that reason.
  - *Separate process:* llama.cpp's `llama-server --embedding`, a 17 MB binary plus the model, with nothing native loaded into the bridge.
- **The history tools:** an MCP process per group turn (Bun start plus opening SQLite, well under 100 ms). The model's own searches are ordinary turn tokens.

## Recommendation

1. **Ship keywords + recall + tools as they are** (default on). They need nothing new installed and cost nothing per message. Claude's own searching through the tools does most of the work: 80% of questions with Haiku and nothing else.
2. **Then add one of these, not both:**
   - **Digests** (`TG_CONTEXT_DIGEST=haiku`): one short Haiku call per finished stretch of conversation, about $0.001 each. Hit@5 went from 71% to 82%, with no model on the box.
   - **Meaning search, all local:** run `llama-server --embedding` with **bge-m3** (MIT, 635 MB) and set `TG_CONTEXT_EMBED_URL`. That gives the same 82% at hit@5, the best ranking of any setup (MRR 0.63), and no calls to anyone. **EmbeddingGemma-300m** (329 MB) is as good and fed the most answers into the automatic block (64–67%). It is better at Persian by the published scores, but it comes under the Gemma terms: commercial use is allowed, subject to a prohibited-use policy.
   - Both together gained little here: bge-m3 already knows what the digests would add.
3. **Measure on the real chat.** Collect 30–50 real "remember when…" questions from the group with the messages that answer them, and rerun `bench.ts` against an export of the real logs. The synthetic chat is a start, not proof.

**Not done yet:**
- an idea and decision registry that tracks which decision replaced which (the research's Phase 1);
- a trigram table for Persian words written without spaces;
- a `/forget` to remove messages from the index;
- tiered summaries per topic (an OpenViking-style L0/L1) that the model could read first.

## Reproduce

```
bun research/context/bench.ts [--digests research/context/digests-haiku.json] [--embed Xenova/multilingual-e5-small | --embed-url http://127.0.0.1:8091 --embed bge-m3]
bun research/context/digests.ts --model haiku --conc 4
bun research/context/agentic.ts --model haiku --conc 3 [--recall] [--digests research/context/digests-haiku.json]
```
