# Third-Party Notices

## Apache Camel and Camel Examples

- Runtime: Apache Camel `4.22.1`
- Examples source: `apache/camel-examples`, commit `e4e8e66b0750190d197e56f139441be4aec59f79`
- License: Apache-2.0

CodexPro directly depends on released Camel artifacts for split, bounded SEDA,
allowlisted routing, and aggregation. No example source is copied.

## Apache KIE / Kogito Examples

- Runtime: Apache Drools `10.1.0`
- Examples source: `apache/incubator-kie-kogito-examples`, stable `10.1.x`
  commit `8a4c86ac2b918e05d3d38a494650a5423d54cff7`
- License: Apache-2.0

CodexPro adapts the embedded stateless-rule-session pattern into project-owned
DRL admission rules. The example application is not copied.

## NanoBrowser

- Source: `nanobrowser/nanobrowser`, commit `24a14b76e14a9c30fd84878ca7985049d1e7d064`
- Version: `0.1.13`
- License: Apache-2.0

NanoBrowser was evaluated for lifecycle and action-schema ideas. It is neither
installed nor redistributed by CodexPro and is not exposed through public MCP.

## Baeldung Tutorials

- Source: `eugenp/tutorials`, commit `60d8145bcade6111468d5f44b4f5102c32fa81d3`
- License: MIT

The tutorials were used only as a routing/MCP cross-check. No source or
Spring dependency is copied.

## Chrome2api

- Source: `xszwow/Chrome2api`, commit `406c5c7a33a6c364c0bd42892250ad1b6a103dad`
- Project-authored source license: MIT

CodexPro wraps Chrome2api's documented loopback OpenAI-compatible HTTP
contract. No Chrome2api source, executable, Chrome runtime DLL, model weight,
cookie, or browser profile is copied or redistributed. The donor's wildcard
CORS, ignored bearer token, and local-file media inputs are intentionally not
exposed through CodexPro.

## Chrome Summarizer guidance and extension sample

- Guidance: `GoogleChrome/modern-web-guidance`, commit
  `66351a783bf1319a1d832f5544f9700098b1047d`
- Sample: `GoogleChrome/chrome-extensions-samples`, commit
  `44de5942b3232d554c0840ba270aedf413d49c62`
- License: Apache-2.0

CodexPro adapts the public option vocabulary and lifecycle semantics for its
bounded local summarization contract. No Google sample code is copied. The
backend is explicitly identified as a Chrome2api compatibility adapter, not as
the native browser `Summarizer` global.

## Chrome summary-of-summaries demo and LangChain text splitter

- Demo: `GoogleChromeLabs/web-ai-demos`, commit
  `8d90f165f1b786b4bf65ad1cfe517a022a5fe1a6`
- Text-splitter reference: `langchain-ai/langchainjs`, commit
  `bd44054c8b269e17dc4296218f9eb9897811ce08`
- Licenses: Apache-2.0 (demo), MIT (LangChain.js)

CodexPro adapts the documented map-then-reduce lifecycle for large documents.
No donor source is copied. The project-owned gap preserves canonical UTF-8 byte
ranges and source roots, caps recursion, and treats every generated summary as
candidate-only output.

## OpenClaw bounded workspace snapshot reference

- Source: `openclaw/openclaw`, commit
  `d9623bd46f3de8bfcc4045859dddf2bbc2865507`
- Reference: `extensions/workspaces/src/manifest.ts`
- License: MIT

CodexPro adapts the donor's bounded 64-file / 8-MiB, content-hashed snapshot
discipline to its document-corpus summarizer. No OpenClaw source is copied and
the widget runtime is not imported. CodexPro reuses its existing workspace path
guard, glob inventory, exact UTF-8 document summarizer, and receipt scheme.
