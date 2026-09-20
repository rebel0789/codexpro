# Chrome2api local inference provider

CodexPro wraps the text-only OpenAI-compatible HTTP surface documented by
[`xszwow/Chrome2api`](https://github.com/xszwow/Chrome2api). Chrome2api remains a
separate node-local process; CodexPro does not copy or redistribute its native
runner, Chrome runtime DLLs, model weights, cookies, or browser profile.

```text
authenticated ChatGPT connector
  -> CodexPro fabric(chrome_complete)
  -> validate bounded text request
  -> fixed literal-loopback endpoint
  -> Chrome2api /v1/chat/completions
  -> validate bounded JSON response
  -> request root + response root + receipt root
```

## Configuration

Start Chrome2api according to its own repository instructions. Its default API
address needs no CodexPro configuration:

```text
http://127.0.0.1:11435/v1
```

To use a different local port, set the startup environment variable before
starting CodexPro:

```powershell
$env:CODEXPRO_CHROME2API_URL = "http://127.0.0.1:11435/v1"
```

Only literal `127.0.0.1` and `[::1]` HTTP URLs ending at `/v1` are admitted.
The model or MCP caller cannot override the endpoint.

## MCP actions

The existing `fabric` tool provides:

- `chrome_contract` - returns the trust boundary and hard limits without
  contacting Chrome2api.
- `chrome_status` - calls `/v1/models` and verifies that
  `chrome-gemini-nano` is advertised.
- `chrome_complete` - sends one non-streaming text completion and returns a
  deterministic receipt binding the admitted request and returned text.
- `chrome_summarizer_contract` - reports the documented Chrome Summarizer
  option/lifecycle surface and identifies the active compatibility backend.
- `chrome_summarize` - executes a bounded local summary through Chrome2api and
  binds the source, normalized options, provider result, and final summary.
- `chrome_summarize_document` - reads a text file inside an admitted workspace
  and runs deterministic chunk/map/reduce summarization for documents up to
  2,000,000 UTF-8 bytes.
- `chrome_summarize_corpus` - resolves a case-sensitive, top-level workspace
  basename glob, hashes and deduplicates its sources, and summarizes each
  unique content exactly once.

Example arguments:

```json
{
  "action": "chrome_complete",
  "system": "Answer concisely using only local inference.",
  "prompt": "Summarize the node inventory.",
  "max_tokens": 256,
  "temperature": 0.2,
  "timeout_ms": 120000
}
```

## Chrome Summarizer compatibility

Chrome's [native Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api)
runs in a top-level browser window or an admitted iframe; it is not currently
available in Web Workers. CodexPro is a Node MCP server, so it does not pretend
that its server-side adapter is the native `Summarizer` global. Instead, it
adapts the complete documented option vocabulary to the existing local
Chrome2api/Gemini Nano lane:

| Option | Admitted values |
| --- | --- |
| `summary_type` | `key-points`, `tldr`, `teaser`, `headline` |
| `summary_format` | `markdown`, `plain-text` |
| `summary_length` | `short`, `medium`, `long` |
| `summary_preference` | `auto`, `speed`, `capability` |
| language hints | `en`, `ja`, `es`, `de`, `fr` |

It also supports `shared_context`, per-call `context`, expected input/context
languages, and an output language. The compatibility backend is batch-only;
the contract records that native Chrome also documents streaming, availability
states, user-activated model downloads, and `downloadprogress` monitoring.

Example:

```json
{
  "action": "chrome_summarize",
  "summary_text": "Long source text...",
  "summary_type": "key-points",
  "summary_format": "markdown",
  "summary_length": "medium",
  "summary_preference": "capability",
  "shared_context": "This is a technical design document.",
  "context": "Focus on operational risks.",
  "expected_input_languages": ["en"],
  "output_language": "en",
  "expected_context_languages": ["en"],
  "timeout_ms": 120000
}
```

The adapter follows Chrome's documented maximum shapes: TLDR/teaser summaries
use up to 1/3/5 sentences, key-points use up to 3/5/7 bullets, and headlines
use up to 12/17/22 words for short/medium/long respectively. These constraints
are instructions to the local model; generated text remains untrusted output.

`summary_preference` and language fields are advisory on the compatibility
backend because Chrome2api exposes one fixed local model. They are normalized,
bound into the receipt, and supplied to the model, but CodexPro does not claim
that they select a different native execution lane.

### Large Markdown and text documents

Use `chrome_summarize_document` after opening the containing directory as a
CodexPro workspace:

```json
{
  "action": "chrome_summarize_document",
  "workspace_id": "downloads",
  "document_path": "ChatGPT-Chrome AI MCP Architecture-20260910-1107.md",
  "summary_type": "key-points",
  "summary_format": "markdown",
  "summary_length": "long",
  "summary_preference": "speed",
  "expected_input_languages": ["en"],
  "output_language": "en"
}
```

The CPU leaf partitions canonical UTF-8 bytes at paragraph, line, or sentence
boundaries, records every exact `[start_byte,end_byte)` span and SHA-256, and
proves that the chunks reconstruct the input exactly. It then uses
`tldr/plain-text/long` map summaries, a maximum of six reduction levels, and
one requested final summary. Canonical source identity never depends on a
browser/model quota. The source is capped at 2 MB, chunks at 48 KB, and chunk
count at 64. All generated text has `authority_ceiling=CANDIDATE_ONLY`.

This adapts Chrome's documented
[summary-of-summaries](https://developer.chrome.com/docs/ai/scale-summarization)
pattern while addressing its stated accuracy risk with exact source manifests,
bounded recursion, deterministic grouping, and explicit receipts.

Before spending model calls, inventory and deduplicate a top-level Markdown
corpus mechanically:

```powershell
npm run chrome-ai:corpus -- E:\Downloads
```

The checker selects case-sensitive `*AI*.md`, verifies UTF-8 and exact chunk
reconstruction, and emits file/content/chunk roots without copying source text.

To summarize that corpus through MCP in one bounded operation:

```json
{
  "action": "chrome_summarize_corpus",
  "workspace_id": "downloads",
  "document_glob": "*AI*.md",
  "summary_type": "key-points",
  "summary_format": "markdown",
  "summary_length": "long",
  "expected_input_languages": ["en"],
  "output_language": "en"
}
```

The glob is a basename-only pattern: path separators and `**` are rejected, and
only files directly under the admitted workspace are considered. The corpus is
capped at 64 documents and 8,000,000 total UTF-8 bytes. Exact duplicate bytes
share one content-summary receipt while each path retains a distinct alias
receipt. Provider execution remains sequential so failure order is stable.

Successful summary calls are reused inside the running CodexPro process by a
key binding the loopback endpoint, exact source root, and normalized options
root. The cache joins concurrent identical calls, stores no source text beyond
the already bounded receipt, retains at most 128 entries / 8 MB, and never
caches failures. Cache hit/miss state is diagnostic only and does not change the
semantic receipt root.

## Enforced boundary

- text only; no image, audio, data URL, or local-file fields;
- no arbitrary URL, redirects, Authorization header, cookies, or browser state;
- 65,536 prompt bytes, 16,384 system bytes, and 81,920 combined input bytes;
- 2,048 maximum requested output tokens;
- 256 KiB maximum HTTP response;
- 2-120 second deadline;
- unstable upstream IDs and timestamps are excluded from proof identity.

Chrome2api's own API has no authentication boundary. Keep it on loopback.
CodexPro authentication still protects the public MCP endpoint.

## Deliberate exclusions

The donor supports local image/audio paths and simulated SSE. Those surfaces
are not exposed because a public MCP caller must not be able to make the local
runtime read arbitrary files, and buffering a simulated stream adds no proof
value. Structured output, tools, embeddings, and Responses API are not claimed.
