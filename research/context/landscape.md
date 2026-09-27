# Context engine: landscape and options

*Researched 2026-09-25; GitHub figures are from that day. Vendor benchmarks are self-reported, and "(unverified)" marks claims I could not confirm.*

## Summary

- **OpenViking: copy the design, not the code.** Its server has been AGPL-3.0 since 2026-03-30. It is a heavy Python service, and its memory extraction needs a strong hosted LLM with no built-in way to use `claude -p`.
- **In group chat, keyword search is hard to beat.** On GroupMemBench (2026-05-14), BM25 scored 43.2%, the best memory system 46.0% and Mem0 25.7%.
- **Recommendation:** a thin layer of our own on bun:sqlite. Start with FTS5 search over the JSONL we already record, then add episode cards and a decision registry from batched Haiku calls. Add embeddings only if tests show misses.
- **Embeddings:** bge-m3 (MIT), or EmbeddingGemma-300m (best Persian scores; Gemma terms, flagged).
- **Licence traps:** AGPL (OpenViking server, Honcho, Basic Memory), non-commercial (Jina), ELv2 (ByteRover), Supermemory's 10k-document cap, and Memori's cloud-side extraction.

## 1. OpenViking (volcengine/OpenViking)

**What it is.** "The Context Database for AI Agents", from the VikingDB team at ByteDance's Volcano Engine.
- Created 2026-01-05; v0.4.21 on 2026-09-20.
- 38.7k stars, 64 releases in six months, marked "Alpha" on PyPI.
- The 0.3→0.4 upgrade needed a one-way data migration.

**Architecture**
- **Filesystem.** Everything lives under `viking://`: `resources/` (shared knowledge), `user/{uid}/` (profile, memories, peers, sessions) and `agent/` (skills). Agents browse it with ls, tree, read and grep over REST, SDKs, a CLI or MCP.
- **Tiers.** Each directory has L0 `.abstract.md` (≤256 characters, vector-indexed), L1 `.overview.md` (≤4k characters, for navigation) and L2, the original content. An LLM writes L0 and L1 bottom-up, one call per non-code file and per directory.
- **Retrieval.** `find` is one vector query limited to a path, with no LLM. `search` has an LLM plan up to five queries, then walks down through the best-matching directories. Regex grep exists, but there is no BM25 ranking.
- **Session memory.** A commit writes a summary and runs an LLM tool loop that extracts typed memories (profile, entities, events…), de-duplicates them and logs a diff. The newest fact wins; there are no validity intervals.

**Licence and weight**
- Apache-2.0 up to v0.2.14, AGPL-3.0 from v0.2.15 (PR #1085). Contributors sign a CLA, and a paid licence is sold. The Rust CLI and the TypeScript SDK stay Apache-2.0.
- Python ≥3.10 plus Rust and C++: about 55 dependencies, about 156 MB of wheels, and about 0.5 GB of RAM (vendor figure, unverified).

**Providers**
- Embeddings: Volcengine, any OpenAI-compatible server (llama-server works), Ollama, or a local GGUF model.
- LLM: Volcengine, any OpenAI-compatible server, or litellm. Anthropic needs a paid API key.
- Only partly local: memory extraction fails with 7B Ollama models (#4879, 2026-09-09).

**Opinion.**
- Nobody has reproduced the vendor's 80–83% on LoCoMo (2026-05-29); one user got 7.7% (#1258).
- Little discussion on Hacker News: the launch got 2 points.
- Juejin (2026-05-18) notes the summary cost is never quantified.
- Wavect (2026-08-21) recommends a "conditional pilot only".
- It also classes Persian text as Arabic.

**Verdict: don't adopt it.** Copy its ideas instead:
- per-scope directories
- L0/L1/L2 disclosure
- one "event" per decision, with speaker and date
- the diff log
- a `find` that needs no LLM call

## 2. Memory frameworks

| Name | License | Local? | Weight | Ingestion LLM cost | Fit for us |
|---|---|---|---|---|---|
| OpenViking | **AGPL-3.0** server | Partly | Python server | ~1 per file or directory; 2–5 per session commit | Low (§1) |
| Mem0 (Python; TS `mem0ai/oss`) | Apache-2.0 | Yes (Ollama, LM Studio) | Library; TS default stores need native better-sqlite3 (failed to load here) | 1 per `add()` since 2026-04; graph memory now cloud-only | Low: flattens speakers; 25.7% on GroupMemBench |
| Zep / Graphiti | Zep Cloud is paid; Graphiti Apache-2.0 | Yes; small models drop dates (#1909) | Python plus Neo4j or FalkorDB | Per episode: entities + edges + dedup; ~160 calls for 5 KB (#1516) | Best temporal model; too many calls |
| Letta (now letta-code) | Apache-2.0 | Yes | A whole agent harness; Python server retired 2026-08 | Periodic "dreaming" passes | Competes with Claude Code; copy its git-backed memory |
| Cognee | Apache-2.0 (open-core hints) | Yes | Python with 54 dependencies; embedded stores | 2 per chunk | Low: built for documents |
| LightRAG | MIT | Wants a ~30B LLM | Python server | 2 per chunk | Poor: no speakers or time |
| MemOS | Apache-2.0 | Plugin: yes | Server needs Neo4j, Qdrant, Redis | Several per turn (unverified) | Low: built for agent tasks |
| Memori | Apache-2.0 | **No**: extraction runs in their cloud | SDK over your SQL database | 1 hosted call per turn | Poor: data leaves the box |
| Honcho | **AGPL-3.0** server | Possible | Postgres + Redis | ~1 per 1k tokens per participant | Best multi-party model; licence blocks it |
| Supermemory | MIT SDKs; capped binary | Yes | ~1.6 GB when idle | Per document (count not published) | Low: doesn't track who said what |
| LangMem | MIT | Yes | Python, LangGraph | 1–2 per run | Poor; stale since 2025-10 |
| A-MEM | MIT | Yes | Python + Chroma | 1–3 per note | Poor; research code |
| HippoRAG 2 | MIT | Defaults assume a GPU | Python + vLLM | 2 per passage | Poor: built for document Q&A |
| txtai | Apache-2.0 | Yes | Python + PyTorch | 0 | Duplicates FTS5 + sqlite-vec |
| claude-mem | Apache-2.0 (AGPL before 2026-05-08) | Uses the Claude subscription | Bun + bun:sqlite | 1 Haiku call per tool use; one user burned 76M tokens in a day (#2315) | Poor for chat; copy its 3-step search |
| Basic Memory | **AGPL-3.0** | Yes | Python MCP server; Markdown + SQLite | 0 | Reference only |
| Hindsight | MIT | Yes; can call Claude Code as its LLM | Python + Postgres, ~2–3 GB | 1 per chunk, plus merges | Tops GroupMemBench; plan B |
| EverOS (formerly EverMemOS) | Apache-2.0 | Yes | Python; SQLite + LanceDB | Segmentation + extraction per episode | Right concepts, but changing fast |
| qmd (tobi) | MIT | Yes | Bun/TS; FTS5 + sqlite-vec + node-llama-cpp | 0 | Closest code to borrow |
| OpenClaw memory | MIT | Yes | Part of OpenClaw | A save turn before compaction, plus a curator | Copy: treats group content as untrusted |
| memsearch (Zilliz) | MIT | Yes | Python + Milvus Lite | 1 Haiku call per turn | Medium |
| Mastra Observational Memory | Apache-2.0 (except `ee/`) | Needs a 128k-context model | TS library | ~1 per 6k tokens | Copy its rolling-summary pattern |
| LongMemory (formerly OpenMemory) | Apache-2.0 | Yes | TS + better-sqlite3 | 0 | Read for "true when" vs "recorded when" timestamps |
| Nemori | MIT | Yes | Python + Postgres + Qdrant | Boundary, narrative and facts per episode | Copy its segmentation |

Also checked, none better for us:
- memU, Memobase, MIRIX, MemoryOS, LightMem, SimpleMem, Memvid, ReMe, Acontext, MemMachine.
- MemPalace: its LongMemEval headline was plain ChromaDB search.
- ByteRover: ELv2.
- Vertex AI Memory Bank: managed only.

## 3. Building blocks for Bun

"Tested" means run on this box with Bun 1.3.14 on Linux.

| Block | License | Bun status | Notes |
|---|---|---|---|
| bun:sqlite FTS5 | Public domain | **Tested**: SQLite 3.53.0 with FTS5, trigram tokenizer and `bm25()` | Normalise Persian first (ي→ی, ك→ک, diacritics, digits) or words are missed. A trigram table catches words written without spaces |
| sqlite-vec | MIT or Apache-2.0 | **Tested**: `sqliteVec.load(db)` works on Linux | Exact search takes 55 ms per query over 100k × 384-dim vectors on one core. Per-topic partitions work. Approximate indexes exist only in alpha releases. Releases paused Nov 2024–Mar 2026 |
| Orama | Apache-2.0 | **Tested** | Pure TS hybrid search. Needs a custom Persian tokenizer. ~870 MB for 50k documents with vectors. No release since 2025-12 |
| LanceDB (Node) | Apache-2.0 | Not documented | Embedded hybrid search; 202 MB binary |
| transformers.js / onnxruntime-node | Apache-2.0 / MIT | Bun crash fixes landed in Bun 1.4.0 (2026-08-20); this box runs 1.3.14 | ~300 MB of native code; run it in a separate process |
| model2vec | MIT | No official JS | Simple to port, but weak on Persian |
| llama.cpp `llama-server` | MIT | Separate process | OpenAI-style `/v1/embeddings` and `/v1/rerank`. Set `-ub` at least as large as the longest input (#25293). node-llama-cpp (MIT) runs in-process, but a segfault on CPU fallback is reported (#554) |

## 4. Embedding models

| Model | Params (active) | Dims | License | ONNX / GGUF | MMTEB | Persian (MTEB-fa / MIRACL-fa) | Note |
|---|---|---|---|---|---|---|---|
| multilingual-e5-small | 118M (22M) | 384 | MIT | yes / community | ~56 | 59.9 / 53–54 | Cheapest; weak on chat |
| multilingual-e5-base | 278M (86M) | 768 | MIT | yes / community | 57.0 | 62.6 / 57–58 | — |
| Qwen3-Embedding-0.6B | 596M (~440M) | 32–1024 | Apache-2.0 | community / official | 64.3 | mixed (unverified) | ~4× EmbeddingGemma's compute |
| EmbeddingGemma-300m | 308M (106M) | 128–768 | **Gemma Terms** | community / yes | 61.2 | **67.8** / – | Best at Persian chat; see licence note below |
| granite multilingual R1 (107m/278m) | 107M / 278M | 384 / 768 | Apache-2.0 | yes / community | 53.7 | not supported | Skip |
| granite multilingual R2 (97m/311m, 2026-04) | 97M / 311M | 384 / 768 | Apache-2.0 | yes (AVX2 int8) / self-convert | 51.9 / 56.0 | – / 49–52 | 32k context |
| bge-m3 | 568M (312M) | 1024 + sparse | MIT | yes / yes | 59.6 | 65.6 / 60.9 | Best OSI-licensed option; ~3× EmbeddingGemma's compute |
| nomic-embed v1.5 / v2-moe | 137M / 475M | 768 | Apache-2.0 | yes / yes | – | v1.5 English-only; v2 – / 59.8 | v2: 512-token limit |
| arctic-embed m-v2.0 / l-v2.0 | 305M / 568M | 768 / 1024 | Apache-2.0 | yes / l only | 53.7 / 57.0 | – / 53.9, 60.7 | — |
| potion-multilingual-128M | 128M static | 256 | MIT | yes / n/a | 47.3 | – / 18.4 | Too weak for search |
| gte-multilingual-base | 305M (113M) | 128–768 | Apache-2.0 | community / no | 58.2 | FaMTEB 57.1 | Good at Persian chat |
| jina v3 / v4 / v5 | 0.2–3.8B | — | **Non-commercial** (CC BY-NC; Qwen Research) | — | v5-small 67.7 | v3 tops FaMTEB | Excluded |

- **MTEB-fa** is our own average over the 52 public MTEB Persian (v2) tasks, not the official leaderboard.
- **Gemma Terms:** commercial use is allowed, but under a prohibited-use policy (it includes tracking people without consent). The terms pass on to anyone you redistribute to, and the download is gated.
- **Estimated throughput here (not measured):** mE5-small ~100–300 messages/s, EmbeddingGemma ~20–50, bge-m3 ~8–15.

## 5. What practitioners say

**Agentic search versus RAG**
- **Claude Code dropped RAG early.**
  - Boris Cherny: "agentic search out-performed RAG" (HN, 2025-02-24).
  - Early builds used Voyage embeddings in a local vector database. Agentic search won "by a lot", judged on "mostly vibes" plus internal benchmarks, and costs more latency and tokens (Latent Space, 2025-05-07).
  - Anthropic's caveat (2026-05-14): "it works best when Claude has enough starting context to know where to look."
- **Context-engineering write-ups agree:**
  - Anthropic (2025-09-29): retrieve just in time, and load a few files up front.
  - Manus (2025-07-18): the file system is "the ultimate context", and compression must be reversible.
  - LangChain (2025-06-23): write, select, compress, isolate.
  - Cognition (2025-06-12): keep "key details, events, and decisions".
- **Counter-evidence:**
  - Cursor gained 12.5% by adding semantic search to grep (2025-11-06).
  - Letta's 74% on LoCoMo used grep plus semantic search (2025-08-12).
  - "Is Grep All You Need?" (2026-05-14) found grep at least as good as vectors on LongMemEval, but says it "punishes vocabulary mismatch".
- **For us:** grep works when there is an anchor word ("Sara", "grant"). Matching "that pricing thing" to a Persian message needs embeddings or LLM-written aliases.

**Memory as files**
- Anthropic's memory tool (2025-09-29) is a client-side `/memories` folder.
- Claude Code auto memory (v2.1.32, 2026-02-05) is a `MEMORY.md` index plus topic files, with no vector index.
- Letta's Context Repositories (2026-02-12) are git-backed markdown.

**Chat techniques**
- **Disentanglement:** time, mentions and reply links are the strongest signals (Kummerfeld et al., 2019). GPT-4o used as-is "performs poorly" (LREC 2026). Telegram already gives us topics and reply-to.
- **Segmentation:** memory units cut at topic boundaries beat per-turn or per-session units (SeCom, ICLR 2025). Nemori cuts chats into episodes an LLM detects.
- **Rolling summaries** (MemGPT, Mastra) should cite message ids so the original can be recovered.
- **Registries and validity:**
  - Architecture decision records (ADRs) mark old decisions "superseded".
  - Graphiti closes superseded facts with `invalid_at`.
  - GroupMemBench's best knowledge-update score is 27.1%. It advises keeping threads, conditioning on the speaker, and tracking beliefs per person.

## 6. Recommendation

Build a thin layer inside the bridge rather than taking a framework dependency.

1. **Phase 0: keyword index, no LLM.**
   - Tail each topic's JSONL into a bun:sqlite database per chat, with speaker, time, topic and reply-to.
   - Index Persian-normalised text with FTS5, plus a trigram table.
   - Give Claude three tools over MCP or a Bash CLI: `search(query, who, since, topic)`, `thread(id)` and `messages(ids)`. Claude writes its own query variants in both languages.
   - Scope every query to the asking chat, and delete derived data when retention prunes messages.
2. **Phase 1: episode cards and registries.**
   - When a topic goes quiet (~30 minutes) or gathers ~40 messages, make one `claude -p --model haiku` call with no tools. It returns JSON for:
     - **episodes:** title, summary, participants, Persian and English keywords, message ids;
     - **ideas:** name, aliases, proposer, date;
     - **decisions:** status (proposed, accepted, reversed or superseded), `supersedes`, valid-from and valid-to, source ids.
   - Write them as per-topic files (`episodes.jsonl`, `ideas.md`, `decisions.md`, a short `TOPIC.md`) and index them too.
   - Treat these files as untrusted input.
   - Add the `TOPIC.md` overview (≤500 tokens) to each mention so Claude knows where to look.
   - Estimated cost: 10–20 Haiku calls a day for a group sending 500 messages a day.
3. **Phase 2: embeddings, only if tests show misses.**
   - Run `llama-server --embeddings` at low priority with bge-m3 Q8_0 (MIT), or EmbeddingGemma if the Gemma terms are accepted.
   - Store vectors in sqlite-vec, partitioned by topic.
   - Merge them with FTS5 results using reciprocal rank fusion.
4. **Measure each phase** on 30–50 real "remember when…" questions with known answers, including reversed decisions and Persian↔English paraphrase.

**Plan B:** Hindsight (MIT, tops GroupMemBench, can use Claude Code as its LLM) as a sidecar. It costs 2–3 GB of RAM, Postgres and an LLM call per chunk, for a 3-point lead over BM25.

## 7. Caveats

- **Not verified:** CPU throughput, OpenViking's RAM use, Supermemory's licence text, and why Qwen3 scores poorly on Persian.
- The MTEB-fa averages are our own calculation.
- Vendors' LoCoMo and LongMemEval scores can't be compared with each other; see the Zep–Mem0 dispute in getzep/zep-papers#5.

## Sources

**OpenViking**
- https://github.com/volcengine/OpenViking (v0.4.21, 2026-09-20)
- https://github.com/volcengine/OpenViking/pull/1085 (licence switch, 2026-03-30)
- https://github.com/volcengine/OpenViking/discussions/992 (2026-03-26)
- https://github.com/volcengine/OpenViking/issues/4879 (2026-09-09)
- https://github.com/volcengine/OpenViking/issues/1258
- https://blog.openviking.ai/post/openviking-benchmark-results/ (2026-05-29)
- https://news.ycombinator.com/item?id=47365646 (2026-03-13)
- https://juejin.cn/post/7640409934489108534 (2026-05-18)
- https://wavect.io/blog/openviking-agent-memory-review/ (2026-08-21)

**Memory frameworks**
- https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx (2026-04-16)
- https://github.com/getzep/graphiti (v0.30.2, 2026-09-08); issues #1516 (2026-05-28) and #1909 (2026-09-23)
- https://www.getzep.com/pricing (read 2026-09-25)
- https://github.com/getzep/zep-papers/issues/5 (2025-05-08)
- https://github.com/letta-ai/letta/pull/3430 (2026-08-16)
- https://docs.letta.com/letta-code/memfs
- https://github.com/topoteretes/cognee
- https://github.com/HKUDS/LightRAG
- https://github.com/MemTensor/MemOS
- https://github.com/MemoriLabs/Memori
- https://github.com/plastic-labs/honcho
- https://github.com/supermemoryai/supermemory (server-v0.0.7 notes, 2026-08-15)
- https://github.com/langchain-ai/langmem
- https://github.com/agiresearch/A-mem
- https://github.com/OSU-NLP-Group/HippoRAG
- https://github.com/neuml/txtai
- https://github.com/thedotmack/claude-mem; issue #2315 (2026-05-05)
- https://github.com/basicmachines-co/basic-memory
- https://github.com/vectorize-io/hindsight; https://arxiv.org/abs/2512.12818 (2025-12-14)
- https://github.com/EverMind-AI/EverOS
- https://github.com/tobi/qmd (v2.8.3, 2026-08-16)
- https://docs.openclaw.ai/concepts/memory
- https://github.com/zilliztech/memsearch
- https://mastra.ai/blog/observational-memory (2026-02)
- https://github.com/CaviraOSS/LongMemory
- https://arxiv.org/abs/2508.03341 (Nemori, 2025-08-05)

**Building blocks**
- https://bun.com/docs/runtime/sqlite
- https://github.com/asg017/sqlite-vec/releases
- https://github.com/oramasearch/orama
- https://github.com/lancedb/lancedb
- https://github.com/huggingface/transformers.js/issues/1672
- https://github.com/oven-sh/bun/issues/30431
- https://github.com/MinishLab/model2vec-rs
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md; issue #25293
- https://github.com/withcatai/node-llama-cpp/issues/554

**Embedding models**
- Hugging Face model cards for every model in §4 (licence tags checked through the HF API on 2026-09-25)
- https://ai.google.dev/gemma/terms (modified 2026-04-01)
- https://ai.google.dev/gemma/prohibited_use_policy
- https://arxiv.org/abs/2502.13595 (MMTEB)
- https://arxiv.org/abs/2502.11571 (FaMTEB, 2025-02)
- https://arxiv.org/abs/2509.20354 (EmbeddingGemma)
- https://arxiv.org/abs/2605.13521 (Granite R2, 2026-05)
- https://github.com/embeddings-benchmark/results

**Practitioners and chat techniques**
- https://news.ycombinator.com/item?id=43164253 (2025-02-24)
- https://www.latent.space/p/claude-code (2025-05-07)
- https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start (2026-05-14)
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09-29)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://code.claude.com/docs/en/memory; Claude Code CHANGELOG v2.1.32 (2026-02-05)
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus (2025-07-18)
- https://rlancemartin.github.io/2025/06/23/context_engineering/ (2025-06-23)
- https://cognition.com/blog/dont-build-multi-agents (2025-06-12)
- https://cursor.com/blog/semsearch (2025-11-06)
- https://www.letta.com/blog/benchmarking-ai-agent-memory (2025-08-12)
- https://www.letta.com/blog/context-repositories/ (2026-02-12)
- https://arxiv.org/abs/2605.15184 ("Is Grep All You Need?", 2026-05-14)
- https://arxiv.org/abs/2605.14498 (GroupMemBench, 2026-05-14)
- https://aclanthology.org/P19-1374/ (Kummerfeld et al., 2019)
- https://aclanthology.org/2026.lrec-1.229/ (LREC 2026)
- https://arxiv.org/abs/2502.05589 (SeCom, ICLR 2025)
- https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions (2011)
