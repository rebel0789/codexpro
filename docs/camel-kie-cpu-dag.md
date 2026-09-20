# Camel/KIE CPU DAG

CodexPro composes Apache Camel and Apache KIE/Drools as a bounded, deterministic
CPU execution surface behind its existing authenticated MCP server.

```text
ChatGPT or local planner
        |
        | JSON facts only
        v
Drools admission policy (fail closed)
        |
        | admitted capability ID
        v
Camel split -> allowlisted route -> bounded SEDA -> stable fan-in
        |
        v
SHA-256-bound receipt
```

## Contract

The planner supplies a plan ID and a finite array of input items. Each item has
an ID, one registered capability ID, and a payload. It cannot supply an endpoint URI, executable,
shell command, credential, Java class, or dependency coordinate.

The default capability registry contains:

- `inventory.identity`
- `inventory.canonicalize`
- `text.uppercase`
- `hash.sha256`

Adding a capability is a code change: implement the processor, register its
fixed ID, bind it into the policy root, and add positive and rejection tests.
There is no model-controlled dynamic endpoint resolution.

## Physical bounds

The logical registry has no architectural ceiling, but each run is physically
bounded:

- at most 512 items;
- at most 65,536 UTF-8 bytes per item;
- at most 4,194,304 total input bytes;
- a SEDA queue of 64;
- at most eight workers and never more than 80% of logical CPUs;
- a Node bridge deadline between 2 and 120 seconds;
- bounded child stdout and stderr capture.

Overflow, an unknown capability, a planner-supplied endpoint, or a shell-like
capability is denied before execution.

## Determinism and receipts

Camel may process items concurrently, but fan-in sorts by the admitted ordinal.
The receipt binds the request root, ordered output root, policy root, plan root,
limits, registered capability set, status, and output count. Replaying the same
admitted request under the same policy produces the same semantic receipt root.

## MCP use

Inspect the contract first:

```text
fabric(action="dag_contract")
```

Then execute a data-only plan:

```json
{
  "action": "dag_execute",
  "dag_json": "{\"planId\":\"example-1\",\"items\":[{\"id\":\"second\",\"capability\":\"text.uppercase\",\"payload\":\"second\"},{\"id\":\"first\",\"capability\":\"text.uppercase\",\"payload\":\"first\"}]}"
}
```

The result order follows the admitted item order regardless of worker completion
order; here the outputs are `SECOND`, then `FIRST`.

## Donor boundary

- Apache Camel `4.22.1` is a direct Maven dependency for routing, bounded SEDA,
  split, and aggregation.
- Apache KIE/Drools `10.1.0` is a direct dependency for embedded stateless
  admission rules.
- Apache Camel examples and Kogito examples are pinned design donors; their
  application source is not copied.
- NanoBrowser was evaluated for lifecycle and action-schema ideas but remains
  opt-in and local-only because of its broad browser permissions.
- Baeldung tutorials are reference-only and are not runtime dependencies.

Pinned commits, classifications, evidence, and license notices are recorded in
`FOSS_REUSE_DECISION.tsv` and `THIRD_PARTY_NOTICES.md`.
