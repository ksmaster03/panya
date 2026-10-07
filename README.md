# panya

**English** · [ภาษาไทย](README.th.md)

![A robot head linked to a second brain made of index cards and small databases](docs/panya-hero.jpg)

**panya** (ปัญญา, "wisdom") is a second brain for AI apps: a memory service that stores facts, finds them again, and says "I don't know" when it has nothing relevant. It does this **without calling an LLM**, so it never rewrites what you stored and never invents a detail.

Built for Thai and English text. Runs on Bun, TypeScript and [seekdb](https://github.com/oceanbase/seekdb).

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
- Tenant isolation enforced on the server; an API key can be bound to one container

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
```

## API

Every route under `/v1` needs `Authorization: Bearer <key>`.

| Route | Purpose |
|---|---|
| `POST /v1/memories` | Store `{ container, text, subject?, attribute?, kind?, validUntil?, source? }` |
| `POST /v1/search` | `{ container, q, limit? }` returns `{ hits, abstained, reason? }` |
| `GET /v1/profile?container=` | Preferences, keyed facts and recent items |
| `PUT /v1/entities` | Register names: `{ container, type, cues, names }` |
| `GET /v1/entities?container=` | List registered names |
| `DELETE /v1/memories/:id?container=` | Delete one memory |

```bash
curl -s localhost:6800/v1/memories -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"container":"warehouse-1","text":"Dock D-02 is closed for leveler repair","subject":"dock:D-02","attribute":"status","validUntil":"2026-10-09T00:00:00Z"}'

curl -s localhost:6800/v1/search -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"container":"warehouse-1","q":"is dock D-02 usable"}'
```

API keys are set in `PANYA_API_KEYS`, comma separated. `key` works for every container; `key@container` works for that container only.

## How it decides

1. Tokenise the query. Thai goes through `Intl.Segmenter`; codes are kept whole.
2. If the query mentions a registered name, keep only memories that mention it. If a cue word such as "customer" is followed by words that appear nowhere in this container's memories, abstain with `reason: "unknown_entity"`.
3. Fetch candidates by vector similarity and by full-text match.
4. Drop candidates that lack a code the query asked for.
5. Score each candidate from normalised similarity and the share of query words it contains. Anything under `minScore` is discarded. No survivors means `abstained: true`.

Thresholds live in `src/config.ts` and come from `bun run eval`, which tunes on half the questions and reports on the other half.

## Results

100 synthetic Thai memories and 120 questions (36 same-wording, 42 paraphrased, 16 off-topic, 26 in-domain with no answer). Numbers below are from the 60 held-out questions, measured on 7 October 2026 on a Windows laptop.

| Held-out set | panya | supermemory, default | supermemory, score threshold |
|---|---|---|---|
| Correct at rank 1 | 82% | 85% | 44% |
| Correct in top 3 | 90% | 92% | 44% |
| Abstains when an answer exists | 10% | 3% | 56% |
| Abstains when no answer exists | 76% | 0% | 100% |
| Search latency (mean) | 31 ms | 78 ms | 78 ms |

Read this honestly: panya does **not** rank better than the baseline. Ranking is about equal. What it adds is the ability to decline: a single score threshold cannot do that without throwing away more than half the real answers.

The baseline is supermemory self-hosted 0.0.8, document search, `multilingual-e5-base`, with no LLM configured. Its LLM memory-extraction mode was not measured: on a free Gemini key it processed about one memory per minute and the run was stopped.

Reproduce: `bun run eval` and `bun eval/baseline-supermemory.ts ingest|measure`.

Other measurements: 42 ms per write, about 1 GB RSS for the panya process, seekdb documents a 2 GB minimum.

## Known limitations

- Paraphrases far from the stored wording are missed (67% correct at rank 1 on paraphrased questions).
- In-domain questions with no answer are still answered about one time in four, for example a question about a carrier's fleet size returns other facts about that carrier.
- Bare numbers and single letters ("gate 5", "zone Z") are not treated as identifiers.
- It cannot summarise. Send one short fact per memory, 2000 characters at most.
- seekdb embedded mode hung on Windows under both Bun and Node (tested 7 October 2026). Use the Docker server.
- The `oceanbase/seekdb` image ignored `ROOT_PASSWORD` in our test; root has an empty password. Set one with SQL before exposing the port.
- The eval set is small and from one domain. Re-run it on your own data before trusting the thresholds.
