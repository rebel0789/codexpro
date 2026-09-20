# Fleet capability invariants

CodexPro treats a developer fleet as one logical capability graph while every
CPU, GPU, memory region, credential, and process remains owned by its node.

The same contract recurs at every scale:

```text
authenticated coordinator
  -> admit typed capability
  -> resolve approved DNS node and trusted host identity
  -> execute within explicit limits
  -> seal a terminal receipt
  -> aggregate receipt roots
```

These rules are executable through `fabric(action="invariants")`:

1. `authenticated-coordinator` - one authenticated ChatGPT session coordinates through CodexPro; it does not receive raw host, browser, GPU, or shell authority.
2. `self-similar-node-contract` - every CodexPro instance exposes the same contract; locality changes the available capabilities, not their admission or receipt shape.
3. `capability-before-execution` - capability and host identity must be admitted before dispatch. Passwordless SSH is transport, never authority.
4. `ai-plan-data-only` - model output is untrusted plan data. It cannot supply an endpoint URI, executable, shell command, credential, or authority.
5. `logical-routing-physical-bounds` - the registered capability graph may grow, but every execution has finite item, byte, queue, worker, timeout, and fanout limits.
6. `node-local-resources` - CPU, GPU, RAM, models, credentials, browser profiles, and private keys stay node-local. Only bounded inputs and receipts cross boundaries.
7. `bounded-fanout` - fanout is finite: at most eight SSH lanes and at most 80% of logical CPUs for local CPU workers.
8. `receipt-required` - queue submission, connectivity, or model prose is not completion. A successful terminal receipt and output hash are required.
9. `fail-closed-drift` - changed host keys, unknown effects, capability drift, timeout, overflow, or missing receipts fail closed.
10. `local-browser-provider` - browser automation is a separately admitted local provider. Unrestricted extension/CDP tools are never exported through public MCP.
11. `no-secret-propagation` - tokens, cookies, passwords, browser state, and private SSH keys are never copied into fleet packets, logs, receipts, or source repositories.

## Donor boundary

- The admitted Synexia SSH fanout owns manifest binding, strict OpenSSH transport, bounded execution, taskflow state, receipts, and Merkle fan-in.
- Apache Camel examples contribute authorize-before-route, audit, split/route/aggregate semantics.
- Apache KIE/Drools contributes the embedded stateless rule-session pattern used for typed, fail-closed plan admission.
- NanoBrowser is an opt-in browser-local donor only. Its `<all_urls>` and debugger permissions make automatic fleet installation inappropriate.
- Baeldung tutorials are reference-only and are not a runtime dependency.
- Chrome2api is wrapped only at its fixed loopback HTTP contract. Native
  executables, Chrome runtime DLLs, weights, local-file media inputs, wildcard
  CORS, and ignored bearer-token behavior are not imported into CodexPro.

See `FOSS_REUSE_DECISION.tsv` and `THIRD_PARTY_NOTICES.md` for pinned revisions and classifications.
