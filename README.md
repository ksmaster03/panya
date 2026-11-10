# panya

**English** · [ภาษาไทย](README.th.md)

![A robot head linked to a second brain made of index cards and small databases](docs/panya-hero.jpg)

**panya** (ปั้นหยา) is a second brain for AI apps: a memory service that stores facts, finds them again, and says "I don't know" when it has nothing relevant. It does this **without calling an LLM**, so it never rewrites what you stored and never invents a detail.

Built for Thai and English text. Runs on Bun, TypeScript and [seekdb](https://github.com/oceanbase/seekdb).

Source-available: free for noncommercial use, [paid license for commercial use](COMMERCIAL.md).

## Why

LLM-based memory layers read your text and write their own version of it. In a trial with one such tool, "closed until Wednesday" came back as "closed until Wednesday 11 October", a date nobody wrote. Each write also took 18 to 25 seconds, and an off-topic question still returned three confident memories.

panya takes the opposite position:

- **Verbatim storage.** `text` comes back exactly as it went in.
- **Rules instead of a model** for updates, expiry, duplicates and identifiers.
- **Abstention.** A search can return nothing, with a reason.

## What it does

- Hybrid retrieval: full-text (Thai word segmentation) plus local multilingual embeddings
- Keyed facts: a new value for the same `subject` + `attribute` supersedes the old one, history is kept
- Expiry: a memory past `validUntil` is no longer returned
- Duplicate merging for unkeyed text
- Identifier rule: if the query names a code (`D-04`, `70-1234`, `BK-2026-0912`), memories without that code are excluded
- Entity registry: knows your customers and carriers by name, and refuses to answer about a name it has never seen
- Tenant isolation enforced on the server; an API key can be bound to one brain
- Your data stays yours: export a whole brain to JSON and import it anywhere

## Quick start

Requires [Bun](https://bun.sh) and Docker.

```bash
bun install
docker volume create panya-seekdb-data
bun run db:up                 # seekdb on 127.0.0.1:2881, takes about 30 s to boot
cp .env.example .env          # set PANYA_API_KEYS
bun run dev                   # http://127.0.0.1:6800
```

```bash
bun run test        # needs seekdb running
bun run typecheck
bun run eval        # retrieval quality on eval/dataset.json
bun eval/run.ts --rerank --haystack <brain>[:<count>]   # same, with the reranker and real memories as distractors
bun run bench       # speed
```

`--haystack <brain>[:<count>]` mixes real memories from one of your brains into the eval as distractors. They are read from the database at run time and removed afterwards; they are never written to a file.

## Windows app (no Docker)

`windows/` builds a per-user Windows installer that needs neither Docker nor admin rights:

```bash
bun windows/build.ts        # Windows x64 only → dist/windows/Panya-Setup.exe
```

The build copies `src/`, installs production dependencies, keeps only the Windows x64 native files, bundles the `multilingual-e5-small` model (so the first start does not download anything) and compiles two programs with `bun build --compile`. `Panya.exe` is the launcher and also the runtime: it starts the server by running itself as Bun (`BUN_BE_BUN=1`), so the package does not carry a second `bun.exe`.

What the installer does:

- Unpacks to `%LOCALAPPDATA%\Programs\Panya` with the `tar.exe` that ships with Windows 10 and 11, adds Start menu and desktop shortcuts (Panya, Stop Panya, Panya settings, Uninstall Panya) and an entry in Settings > Apps. It asks whether to start Panya when you sign in. Flags: `--yes`, `--no-autostart`, `--no-launch`.
- Stores memories in SQLite (`PANYA_STORE=sqlite`) under `%LOCALAPPDATA%\Panya\data`, separate from the program, so installing a newer version over an old one keeps them. Settings are in `%LOCALAPPDATA%\Panya\panya.env` (port, and `PANYA_HOST=0.0.0.0` to allow other machines on the LAN), the log is in `logs\panya.log`.
- The first time, the sign-in page becomes a setup page that creates the administrator (`PANYA_SETUP=local`). It accepts requests only from the same computer, judged by the real connection address, and closes once any user exists.
- Uninstall from Settings > Apps or the Start menu. Memories are kept unless you run `Panya.exe --uninstall --purge`.

Measured on this machine (Windows 11, no GPU): the installer is 271 MB, installs in 12 s, the server is ready about 3.5 s after launch and uses about 750 MB of RAM. The whole test suite passes against the SQLite store too (`PANYA_STORE=sqlite PANYA_DATA_DIR=<temp folder> bun test`). With 30,000 synthetic memories in one brain, a vector search takes about 40 ms once the vectors are in memory (about 0.4 s for the first search after start-up) and a word search 0.2 to 0.3 s.

The SQLite store (`src/sqlite.ts`) implements only the parts of the seekdb collection API that panya uses. Vectors are compared one by one in memory instead of through an HNSW index, and words are matched through a table of the already tokenized words, scored with BM25. That is fine for tens of thousands of memories per brain; for a shared server with many large brains, use seekdb. To move memories from a Docker install, use `GET /v1/export` there and `POST /v1/import` in the app.

Not done yet: the installer and `Panya.exe` are not code-signed, so Windows SmartScreen shows "Windows protected your PC" (More info > Run anyway). Audio and video transcription still needs Python with `faster-whisper`, and image OCR needs Tesseract, on that computer. seekdb's own embedded mode lists Windows, but on this machine it hung at start-up under both Bun and Node, which is why the app uses SQLite.

## Start automatically on Windows

`scripts/start-panya.ps1` starts Docker Desktop if it is not running, brings up the seekdb container, waits for it, then keeps `bun src/index.ts` running: after a crash it restarts 15 s later. Output goes to `logs/panya.log`.

To run it at every logon without admin rights, put a small `.vbs` file in the Startup folder (Win+R, then `shell:startup`):

```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""<path-to-repo>\scripts\start-panya.ps1""", 0, False
```

It starts when you log on, not when the machine boots; Docker Desktop also needs a logged-in session. To stop panya, end the `powershell` launcher first and then `bun`, otherwise the launcher starts it again.

## Run with Docker

`Dockerfile` builds the server with the embedding model baked in, so it needs no internet at start-up. `deploy/docker-compose.prod.yml` runs panya and seekdb beside an existing app on the same host: nothing is published to the host, the app reaches panya at `http://panya:6800` over its own Docker network, and both containers have memory caps.

```bash
cd deploy
printf 'PANYA_API_KEYS=%s
' "$(openssl rand -hex 32)" > .env && chmod 600 .env
APP_NETWORK=<your app's docker network> docker compose -f docker-compose.prod.yml up -d --build
```

Measured on 8 October 2026 with 2,000 memories and 360 concurrent searches under those caps: panya about 575 MB, seekdb about 160 MB.

## API

Every route under `/v1` needs `Authorization: Bearer <key>`.

| Route | Purpose |
|---|---|
| `POST /v1/memories` | Store `{ brain, text, subject?, attribute?, kind?, validUntil?, source?, ref?, panya? }` |
| `POST /v1/documents` | Split a long document into chunks and store them: `{ brain, text, source, panya?, max?, overlap?, headings? }`. See [Long documents](#long-documents-and-chunking) |
| `POST /v1/files` | Upload a file (multipart: `file`, `brain`, `source?`, `panya?`, `kind?`): documents, audio, video or images. Returns a job; add `?wait=1` to wait. See [Files](#files-documents-audio-video-images) |
| `GET /v1/files/jobs/:id` | Status of an upload: `queued`, `running` (with `progress`), `done` or `error` |
| `GET /v1/files/types` | Which file types this server can read, and whether audio and images are enabled |
| `PATCH /v1/memories/:id` | Set or clear the wisdom label: `{ brain, panya }` |
| `POST /v1/memories/batch` | Store up to 200 at once: `{ brain, memories: [...] }`. All-or-nothing validation |
| `POST /v1/search` | `{ brain, q, limit?, minScore?, rerank?, panya? }` returns `{ hits, abstained, reason? }`. `rerank: false` skips the optional reranker for this request |
| `GET /v1/graph?brain=` | Nodes with 2D positions and nearest-neighbour edges, for the brain view |
| `GET /v1/points?brain=` | Every live memory as a 2D point (PCA over all embeddings) with its group and date, plus neighbour edges over a spread-out sample. No memory text. Computed at start-up and cached for 10 minutes |
| `GET /v1/memories/:id?brain=` | One memory, used to show its text when you point at it on the dashboard |
| `GET /v1/profile?brain=` | Preferences, keyed facts and recent items |
| `PUT /v1/entities` | Register names: `{ brain, type, cues, names }` |
| `GET /v1/entities?brain=` | List registered names |
| `GET /v1/export?brain=` | Everything in the brain as JSON (`&history=1` includes superseded versions) |
| `POST /v1/import` | Load an export: `{ brain, memories, entities?, replace? }`, up to 5000 per request |
| `GET /v1/stats?brain=` | Number of live memories |
| `DELETE /v1/memories/:id?brain=` | Delete one memory |
| `DELETE /v1/sources?brain=&source=` | Delete everything that came from one source |
| `DELETE /v1/brain?brain=&confirm=` | Erase a brain. `confirm` must repeat the brain name |

```bash
curl -s localhost:6800/v1/memories -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"brain":"warehouse-1","text":"Dock D-02 is closed for leveler repair","subject":"dock:D-02","attribute":"status","validUntil":"2026-10-09T00:00:00Z"}'

curl -s localhost:6800/v1/search -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"brain":"warehouse-1","q":"is dock D-02 usable"}'
```

A **brain** is one isolated set of memories (one customer, one project, one agent). API keys are set in `PANYA_API_KEYS`, comma separated. `key` works for every brain; `key@brain` works for that brain only. The field name `container` from earlier versions is still accepted.

## Brain view

Open `http://127.0.0.1:6800/brain` and sign in with a brain name and its API key. The page has an export button that downloads the whole brain as JSON, and an **Add files** button (or drop files onto the brain) that sends documents, audio, video and images to `/v1/files`. Every memory is a point inside a brain outline; memories with similar meaning sit close together and are joined by lines. Type a question and the matching memories light up, or the page tells you the brain chose not to answer. The page itself holds no data: everything comes from `/v1/graph` and `/v1/search` with your key.

## Import Claude Code memory

```bash
bun run import:claude-memory --dry          # count what would be imported
bun run import:claude-memory                # every ~/.claude/projects/*/memory folder
bun run import:claude-memory <folder> --brain my-notes
```

Each file becomes several short memories (its description plus paragraph-sized chunks). Tokens and keys are replaced with `[redacted]` before storage. Re-running replaces what was imported from the same file. The data stays in your local seekdb.

## Dashboard

Open `http://127.0.0.1:6800/dashboard` and sign in with an API key. It shows every brain the key can reach: a 3D core with one orb per brain, memories flying in (writes) and out (searches) as they happen, a live feed, signal strips, write and search charts, and a sortable statistics table. Thai and English, switchable in the header. Data comes from `GET /v1/overview` (statistics, cached for five seconds) and `GET /v1/events` (the last 300 writes, searches and deletes that went through this server; kept in memory, so a restart clears them).

A row of buttons above the numbers switches between all brains and one brain at a time; the numbers, charts, live feed, signal strips and the highlighted orb then follow that brain, and the choice is kept in the URL (`/dashboard?brain=<name>`) so a link opens the same view. Clicking an orb or a table row selects that brain too.

The 3D brain in the middle plots every live memory of the selected brains as a coloured point (colour = group, as on `/brain`), with neighbour links and signals running along them; with tens of thousands of memories it draws small squares instead of glows to keep the frame rate up (about 21 fps with 23,648 points on a laptop CPU). A sample appears first and the full set replaces it when ready. Viewers without a key see positions, groups and dates only; with a key, pointing at a point fetches its text.

## Warehouse view

Open `http://127.0.0.1:6800/warehouse` for the same data as a 3D warehouse (Three.js r170, bundled in `src/assets`, no internet needed): each brain is a zone with its own dock door and forklift, each group is a rack (the 9 largest groups per brain, the rest folded into "Other"), and each box stands for a fixed number of memories shown on screen (100 per box at 41,871 memories). Boxes received in the last 24 hours are lighter. Real writes send that zone's forklift from the dock to the matching rack; a search makes the racks of that brain glow. Click a rack for its count, share of the zone, and last write. Same access rules as the dashboard; uses `/v1/overview`, `/v1/points` and `/v1/events`.

To let people view the dashboard without a key, set `PANYA_PUBLIC_DASHBOARD=lan` (no key needed from this machine and private network addresses) or `all`. Only `GET /v1/overview` and `GET /v1/events` open up, read-only; the live feed then shows memory text and search questions to anyone who can reach the page. `lan` trusts the connection's own address, so behind a reverse proxy every request looks local: do not use it there. A request that sends a wrong key is still refused.

A sound bar sits at the bottom of the dashboard: play/pause, a waveform of the whole track that you click to seek, live frequency bars, and volume. It plays `src/assets/mr-scratch.mp3`, served at `GET /assets/<file>` (only mp3, ogg and wav files in `src/assets`, with Range support). The audio file is not included in the repository: put your own file at that path.

## Claude Code skills

`skills/` holds two example skills that let Claude Code on any machine share skills and memory through one panya server, over the HTTP API. Copy a folder into `~/.claude/skills/` and run its `setup` once:

```bash
node ~/.claude/skills/panya-memory/scripts/panya-memory.mjs setup --url http://<host>:6800 --key <api key>
```

| Skill | Send | Receive |
|---|---|---|
| `panya-skills` | `push` every `SKILL.md` and command into the `claude-skills` brain | `list`, `search`, `show <name>`, or `pull <name>` to install one locally |
| `panya-memory` | `push` Claude Code memory files, or `remember "<fact>"` | `search "<question>"`, `list`, `show`, or `pull <project> --to <dir>` |

Both need only Node 18+. Only `.md` files travel: a skill's scripts and assets are not sent. Documents are rebuilt from their chunks with `GET /v1/memories?brain=&subject=`; `GET /v1/subjects?brain=&prefix=` lists what is stored.

## How it decides

1. Tokenise the query. Thai goes through `Intl.Segmenter`; codes are kept whole.
2. If the query mentions a registered name, keep only memories that mention it. If a cue word such as "customer" is followed by words that appear nowhere in this brain's memories, abstain with `reason: "unknown_entity"`.
3. Fetch candidates by vector similarity and by full-text match.
4. Drop candidates that lack a code the query asked for.
5. Score each candidate from normalised similarity and the share of query words it contains. Anything under `minScore` is discarded. No survivors means `abstained: true`.

Thresholds live in `src/config.ts` and come from `bun run eval`, which tunes on half the questions and reports on the other half.

## Three kinds of wisdom (panya 3)

Every memory can carry one of the three kinds of wisdom from Buddhist teaching. The label records where the knowledge came from, not what it is about:

| `panya` | Name | Where the knowledge came from |
|---|---|---|
| `suta` | สุตมยปัญญา | Heard or learned: something read, told, documented, a spec or a rule |
| `cinta` | จินตมยปัญญา | Thought through: analysis, a conclusion, a decision and its reason, a plan |
| `bhavana` | ภาวนามยปัญญา | Practised: a lesson learned, first-hand experience, what worked when tried |

- Send `panya` with a memory to set the label yourself. A label you set is never overwritten.
- If you leave it out, the **governor** labels the memory. It only labels; it never writes or changes text.
- Search with `"panya": "bhavana"` or `"panya": ["suta", "cinta"]` to search one kind only. The brain page has the same filter.
- `PATCH /v1/memories/:id` with `{ brain, panya }` fixes a label (`""` clears it).
- Each memory also has `panyaBy` (`user`, `proto` or `llm`) and `panyaConf` (0-1), so you can tell a guess from a label someone chose.

The governor has two modes.

- **proto** (default) compares the memory's embedding, which is already computed when it is stored, with example sentences for each kind, plus a few cue words. It adds about nothing to write time and runs on the 4 GB cloud machine.
- **ollama** asks a local language model (default `qwen3:4b-instruct`) for one word. It is more accurate but takes 1-3 seconds per memory on a laptop CPU. It is used for relabelling after the fact, never on the write path: `bun run govern <brain> --mode ollama`. Labels set by a user are skipped, and if Ollama fails the memory keeps a proto label.

Settings: `PANYA_GOVERNOR` (`proto`, `ollama` or `off`), `PANYA_OLLAMA_URL`, `PANYA_GOVERNOR_MODEL`.

Measured on 9 November 2026 (`bun eval/govern.ts --ollama`). The fresh set is 30 sentences written after the cue words were fixed and never used for tuning.

| Governor | Holdout (36) | Fresh set (30) | Time per memory |
|---|---|---|---|
| proto, embedding only | 67% | not measured | about 20 ms |
| proto, embedding + cue words | 97% | 77% | about 20 ms |
| ollama `qwen3:4b-instruct` | 92% | 90% | about 1.7 s |

Smaller models were tried on 10 November 2026 and none of them is good enough. Each one did worse than proto on the fresh set, so `qwen3:4b-instruct` stays the smallest model worth running.

| Model (Ollama) | Size | Holdout (36) | Fresh set (30) | Time per memory |
|---|---|---|---|---|
| `qwen3:1.7b` | 1.4 GB | 78% | 50% | about 0.9 s |
| `qwen2.5:1.5b` | 1.0 GB | 72% | 43% | about 0.7 s |
| `qwen3:0.6b` | 0.5 GB | 56% | not run | about 0.5 s |
| `llama3.2:1b` | 1.3 GB | 33% | not run | about 1.0 s |
| `gemma3:1b` | 0.8 GB | 33% | not run | about 2.2 s |

Read the proto holdout number with care: the cue words were written by someone who had seen those sentences, so the fresh set (77%) is the honest figure. Two things went wrong on the way and are handled in the code. `qwen3:4b` (the thinking model) ignored `think: false` and took about 60 s per memory. Forcing a JSON enum made it answer `suta` for everything.

## Long documents and chunking

`POST /v1/documents` with `{ brain, text, source, panya?, max?, overlap?, headings? }` splits a long Markdown or plain-text document into chunks and stores each one as a memory with `ref = source#n`.

- Chunks never cross a heading. They are built from whole lines or sentences.
- `headings` (default on) puts the heading path, for example `Branch manual › Bang Na › Opening hours`, in front of each chunk. Text that repeats under several headings then stays tied to its own heading.
- `overlap` repeats the last sentences of a chunk at the start of the next one.
- Sending the same `source` again replaces that document's old chunks.
- If any chunk contains a secret, nothing is stored.

The defaults (`max 300, overlap 120, headings on`) were chosen with `bun eval/chunks.ts`. That run used 4 synthetic documents and 57 questions: 50 have an answer in the text and 7 do not. A chunk counts as relevant when it contains the whole answer span.

| Chunking | R@1 | R@3 | MRR | nDCG@5 | Abstains when no answer |
|---|---|---|---|---|---|
| Paragraphs, 700 (the importer for skills and memory files) | 86% | 96% | 0.914 | 0.919 | 29% |
| Sentences 300, no headings | 80% | 98% | 0.892 | 0.904 | 71% |
| **Sentences 300, overlap 120, headings** | **92%** | **100%** | **0.957** | **0.944** | **71%** |

The Claude Code memory and skill importers keep the paragraph chunker on purpose. Those memories must be rebuilt into the original file byte for byte, and headings and overlap would break that. The set is small and the defaults were picked on it, so check them on your own documents.

`bun eval/run.ts` now also reports MRR and nDCG@5 next to the rank-1 and top-3 numbers.

## Files: documents, audio, video, images

`POST /v1/files` takes any file, pulls the text out of it and stores it the same way as `/v1/documents`. The source defaults to the file name, so uploading a file with the same name again replaces its old chunks. Only the text is kept; the file itself is not stored. On the brain page, use the **Add files** button or drop files onto the brain.

| Kind | Types | How the text is read |
|---|---|---|
| Documents | PDF, Word (`docx`), PowerPoint (`pptx`, with speaker notes), Excel (`xlsx`), OpenDocument (`odt`, `odp`, `ods`), EPUB, RTF, HTML | In JavaScript, no extra programs. Pages, slides and sheets become headings, so every chunk says where it came from. Table rows become `column: value · column: value` |
| Text | `txt`, `md`, `csv`, `tsv`, `json`, `srt`, `vtt` and any other text file (code, logs, config) | UTF-8, UTF-16 or TIS-620 (old Thai files) |
| Audio and video | `mp3`, `wav`, `m4a`, `ogg`, `flac`, `mp4`, `mov`, `mkv`, `webm` and more | Speech to text with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`large-v3-turbo`) through `scripts/transcribe.py`. Every line keeps its time, for example `[1:05] ...` |
| Images | `png`, `jpg`, `webp`, `tiff`, `bmp`, `gif` | OCR with Tesseract (`tha+eng`) |

The text is the file's own words. Speech recognition and OCR transcribe; they do not summarise or rewrite. Every chunk goes through the same secret check as any other memory.

Audio, video and images need programs on the server, and the server turns them on by itself when it finds them (`GET /v1/files/types` shows what it found).

- Speech: `pip install faster-whisper`. The model (about 800 MB) downloads on first use. Video works without ffmpeg.
- OCR: Tesseract with the Thai language pack. The Docker image already includes it.
- The Docker image does not include speech recognition: it needs Python and is too slow on a 4 GB machine. Upload audio and video to a panya that runs on a computer with faster-whisper.

Settings: `PANYA_UPLOAD_MAX_MB` (default 200; Cloudflare's free plan stops uploads at 100 MB), `PANYA_ASR` and `PANYA_OCR` (`off` turns them off), `PANYA_PYTHON`, `PANYA_ASR_MODEL`, `PANYA_ASR_LANG` (empty = detect), `PANYA_TESSERACT`, `PANYA_OCR_LANG`.

What was checked on 10 November 2026 (`bun test test/files.test.ts`):

- Speech: on 45 s of Thai speech, `large-v3-turbo` got almost every word right and took 39 s on this laptop's CPU. `small` took 393 s and made far more mistakes. Whisper running inside Bun (transformers.js) only repeated one word, so it is not used.
- OCR: about 0.6 s per image in the Docker image. Numbers and English come out right; Thai sometimes loses a tone mark (หนี้ becomes หนี).
- PDF: some Thai PDFs store a character in a way pdf.js cannot read back. In the test file, น้ำ came out as นำ.
- Transcripts are cut into 150-character chunks, not 300. On the test clip, a question that does not repeat the clip's words scored 0.38 instead of 0.27. This is one clip, not a benchmark.
- Not supported: old binary Office files (`doc`, `xls`, `ppt`: save them as `docx`, `xlsx`, `pptx`) and scanned PDFs without a text layer (export the pages as images).

Uploads are processed one at a time in the background. The job list lives in memory, so it is lost when the server restarts.

## Reranker (optional)

A small cross-encoder (`onnx-community/bge-reranker-v2-m3-ONNX`, run through transformers.js like the embedder) can score each (question, memory) pair among the top candidates and blend that with the existing score. It only scores; it never writes or rewrites text.

It is off by default.

- `PANYA_RERANK=1` turns it on.
- `PANYA_RERANK_TOP` (default 10) is how many top candidates are rescored.
- `PANYA_RERANK_WEIGHT` (default 0.7) and `PANYA_RERANK_MIN_SCORE` (default 0.2) control the blend and the cut-off.
- A request can skip it with `"rerank": false` in `POST /v1/search`. The response has `"reranked": true` when it ran.
- For Docker, `--build-arg BAKE_RERANKER=1` bakes the model (about 570 MB) into the image.

Measured on 12 October 2026 on a laptop CPU (Intel i7-1165G7, no discrete GPU). The eval set was 100 synthetic Thai memories plus 7,088 real memories as distractors, with 120 questions.

| Setup | Correct at rank 1 | Abstains when no answer exists | Search time (mean) |
|---|---|---|---|
| Default thresholds | 82% | 60% | 81 ms |
| Re-tuned thresholds, no reranker (`lexWeight=0.5 simFloor=0.84 simCeil=0.9 minScore=0.4`) | 79% | 90% | 81 ms |
| Reranker, top 5 | 82% | 95% | 1,700 ms (p95 4,300 ms) |

The first row is all 120 questions with the shipped defaults. The other two rows are the 60 held-out questions after tuning on the other 60.

Read this honestly: on a CPU, most of the gain is available for free by re-tuning the thresholds on your own data. The reranker adds a few points at a large latency cost, so it is worth it mainly with a GPU or when queries are rare.

Two smaller rerankers were tried and rejected: `Xenova/bge-reranker-base` dropped Thai rank-1 accuracy to 72%, and `gte-multilingual-reranker-base` does not load in transformers.js.

Reproduce: `bun eval/run.ts --rerank --haystack <brain>[:<count>]`.

## Results

100 synthetic Thai memories and 120 questions (36 same-wording, 42 paraphrased, 16 off-topic, 26 in-domain with no answer). Numbers below are from the 60 held-out questions, measured on 7 October 2026 on a Windows laptop.

| Held-out set | panya | supermemory, default | supermemory, score threshold |
|---|---|---|---|
| Correct at rank 1 | 82% | 85% | 44% |
| Correct in top 3 | 90% | 92% | 44% |
| Abstains when an answer exists | 10% | 3% | 56% |
| Abstains when no answer exists | 76% | 0% | 100% |
| Search latency (mean) | 20 ms | 78 ms | 78 ms |

Read this honestly: panya does **not** rank better than the baseline. Ranking is about equal. What it adds is the ability to decline: a single score threshold cannot do that without throwing away more than half the real answers.

The baseline is supermemory self-hosted 0.0.8, document search, `multilingual-e5-base`, with no LLM configured. Its LLM memory-extraction mode was not measured: on a free Gemini key it processed about one memory per minute and the run was stopped.

Reproduce: `bun run eval` and `bun eval/baseline-supermemory.ts ingest|measure`.

Speed, from `bun run bench` on 8 October 2026 (same laptop, seekdb in Docker):

| Operation | Time |
|---|---|
| Search, new query | 18 ms mean, 30 ms p95 |
| Search, repeated query (embedding cached) | 9 ms mean, 14 ms p95 |
| 120 searches fired at once | 236 queries per second |
| Write, one at a time | 25 ms per memory |
| Write, batch endpoint | 12 ms per memory |

Memory: about 1 GB RSS for the panya process; seekdb documents a 2 GB minimum.

## Known limitations

- Paraphrases far from the stored wording are missed (67% correct at rank 1 on paraphrased questions).
- In-domain questions with no answer are still answered about one time in four, for example a question about a carrier's fleet size returns other facts about that carrier.
- With thousands of memories in one brain the shipped thresholds answer too readily: correct abstention fell to 60% with 7,088 distractors. Re-tune them with the haystack eval.
- Bare numbers and single letters ("gate 5", "zone Z") are not treated as identifiers.
- It cannot summarise. Send one short fact per memory, 2000 characters at most.
- seekdb embedded mode hung on Windows under both Bun and Node (tested 7 October 2026). Use the Docker server.
- The `oceanbase/seekdb` image ignored `ROOT_PASSWORD` in our test; root has an empty password. Set one with SQL before exposing the port.
- The eval set is small and from one domain. Re-run it on your own data before trusting the thresholds.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for personal, research, educational and other noncommercial use. **Commercial use needs a paid license**: see [COMMERCIAL.md](COMMERCIAL.md).

This is a source-available license, not an OSI-approved open source license.

All names in `eval/dataset.json` are invented for testing. Any resemblance to a real company or person is coincidental.
