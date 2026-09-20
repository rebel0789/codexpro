export const FLEET_CAPABILITY_INVARIANTS = Object.freeze([
  Object.freeze({ id: "authenticated-coordinator", statement: "One authenticated ChatGPT session coordinates through CodexPro without receiving raw host, browser, GPU, or shell authority." }),
  Object.freeze({ id: "self-similar-node-contract", statement: "Every CodexPro node exposes the same admission, execution, and receipt contract; locality changes available capabilities only." }),
  Object.freeze({ id: "capability-before-execution", statement: "A typed capability and trusted host identity are required before dispatch; passwordless SSH is transport, not authority." }),
  Object.freeze({ id: "ai-plan-data-only", statement: "AI may propose typed plan data but cannot emit executable endpoint URIs, shell commands, or hot-path routing decisions." }),
  Object.freeze({ id: "logical-routing-physical-bounds", statement: "The capability graph may grow without a fixed logical ceiling while every execution has finite item, byte, queue, worker, and time limits." }),
  Object.freeze({ id: "node-local-resources", statement: "CPU, GPU, RAM, models, credentials, browser profiles, and private keys remain owned by their node." }),
  Object.freeze({ id: "bounded-fanout", statement: "Fleet fanout is bounded to eight SSH lanes and local CPU work is bounded to eighty percent of logical CPUs." }),
  Object.freeze({ id: "receipt-required", statement: "Connectivity, queue submission, and model prose are not completion; a terminal receipt and output hash are required." }),
  Object.freeze({ id: "fail-closed-drift", statement: "Changed host keys, unknown effects, capability drift, timeout, overflow, or missing receipts fail closed." }),
  Object.freeze({ id: "local-browser-provider", statement: "Browser automation is separately admitted and local-only; unrestricted extension or CDP tools are never exported through public MCP." }),
  Object.freeze({ id: "no-secret-propagation", statement: "Tokens, cookies, passwords, browser state, and private SSH keys never enter fleet packets, logs, receipts, or source repositories." })
] as const);

type FleetConfig = {
  sshTargets?: string[];
  sshExecMode?: string;
  browserProviderEnabled?: boolean;
};

export function fleetCapabilityContract(config: FleetConfig = {}) {
  const targets = [...new Set((config.sshTargets ?? []).map((target) => target.trim().toLowerCase()).filter(Boolean))].sort();
  return {
    schema: "codexpro.fleet-capability-invariants.v1",
    coordinator: "authenticated-chatgpt-via-codexpro",
    same_contract_every_node: true,
    aggregate_compute_is_logical: true,
    raw_device_authority_to_model: false,
    ssh: {
      transport_only: true,
      arbitrary_public_shell: false,
      execution_mode: config.sshExecMode ?? "not-configured",
      configured_targets: targets,
      max_lanes: 8,
      strict_host_identity_required: true
    },
    cpu: { max_worker_fraction: 0.8 },
    dag: {
      planner_is_data_only: true,
      endpoint_uris_from_model: false,
      logical_routes_are_registry_bounded: true,
      physical_execution_is_bounded: true,
      executor: "apache-camel-4.22.1-lts"
    },
    browser: {
      provider_enabled: config.browserProviderEnabled ?? false,
      local_only: true,
      unrestricted_tools_publicly_exposed: false,
      automatic_extension_installation: false
    },
    proof: {
      terminal_receipt_required: true,
      output_hash_required: true,
      queue_submission_is_completion: false
    },
    secrets: {
      remain_node_local: true,
      copied_to_packets_or_receipts: false
    },
    invariants: FLEET_CAPABILITY_INVARIANTS
  } as const;
}
