package com.synexia.codexpro.dag;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.UnaryOperator;
import org.apache.camel.CamelContext;
import org.apache.camel.Exchange;
import org.apache.camel.ProducerTemplate;
import org.apache.camel.builder.RouteBuilder;
import org.apache.camel.impl.DefaultCamelContext;

public final class CamelCpuDag implements AutoCloseable {
  public static final String SCHEMA = "codexpro.camel-cpu-dag.receipt.v1";
  private static final String ENDPOINT_HEADER = "CodexProDagEndpoint";
  private static final String PLAN_ID_PROPERTY = "CodexProPlanId";
  private static final String PLAN_ROOT_PROPERTY = "CodexProPlanRoot";
  private static final String REQUEST_ROOT_PROPERTY = "CodexProRequestRoot";

  private final DagLimits limits;
  private final Map<String, UnaryOperator<String>> capabilities;
  private final Map<String, String> endpoints;
  private final DagPolicy policy;
  private final CamelContext context;
  private final ExecutorService splitWorkers;
  private final ProducerTemplate producer;

  public CamelCpuDag(DagLimits limits, Map<String, UnaryOperator<String>> capabilityProcessors)
      throws Exception {
    this.limits = Objects.requireNonNull(limits, "limits");
    this.capabilities = Map.copyOf(validateCapabilities(capabilityProcessors));
    this.endpoints = buildEndpoints(this.capabilities.keySet());
    this.policy = new DagPolicy();
    this.splitWorkers = Executors.newFixedThreadPool(limits.workerCount());
    this.context = new DefaultCamelContext();
    this.context.addRoutes(routes());
    this.context.start();
    this.producer = this.context.createProducerTemplate();
  }

  public static CamelCpuDag createDefault() throws Exception {
    Map<String, UnaryOperator<String>> processors = new LinkedHashMap<>();
    processors.put("inventory.identity", value -> value);
    processors.put("inventory.canonicalize", value -> value.replace("\r\n", "\n").trim());
    processors.put("text.uppercase", value -> value.toUpperCase(Locale.ROOT));
    processors.put("hash.sha256", Hashing::sha256);
    return new CamelCpuDag(DagLimits.boundedDefaults(), processors);
  }

  public DagReceipt execute(DagRequest request) {
    return producer.requestBody("direct:codexpro-cpu-dag", request, DagReceipt.class);
  }

  public DagLimits limits() {
    return limits;
  }

  public List<String> capabilityIds() {
    return capabilities.keySet().stream().sorted().toList();
  }

  private RouteBuilder routes() {
    return new RouteBuilder() {
      @Override
      public void configure() {
        errorHandler(noErrorHandler());
        capabilities.forEach((capability, processor) ->
            from(endpoints.get(capability))
                .routeId("codexpro-capability-" + Hashing.sha256(capability).substring(0, 12))
                .process(exchange -> processItem(exchange, capability, processor)));

        from("direct:codexpro-cpu-dag")
            .routeId("codexpro-cpu-dag")
            .process(CamelCpuDag.this::admit)
            .split(body(), new StableFanIn())
              .executorService(splitWorkers)
              .synchronous()
              .stopOnException()
              .process(CamelCpuDag.this::bindEndpoint)
              .recipientList(header(ENDPOINT_HEADER))
                .stopOnException()
              .end()
            .end()
            .process(CamelCpuDag.this::seal);
      }
    };
  }

  private void admit(Exchange exchange) {
    DagRequest request = exchange.getMessage().getBody(DagRequest.class);
    if (request == null || request.planId() == null || request.planId().isBlank()) {
      throw new IllegalArgumentException("planId is required");
    }
    if (request.items() == null || request.items().isEmpty()) {
      throw new IllegalArgumentException("At least one DAG item is required");
    }
    if (request.items().size() > limits.maxItems()) {
      throw new IllegalArgumentException("DAG item count exceeds maxItems=" + limits.maxItems());
    }

    int totalBytes = 0;
    for (DagItem candidate : request.items()) {
      DagItem item = Objects.requireNonNull(candidate, "DAG item");
      requireToken("item.id", item.id());
      requireToken("item.capability", item.capability());
      String payload = Objects.requireNonNull(item.payload(), "item.payload");
      int payloadBytes = payload.getBytes(StandardCharsets.UTF_8).length;
      if (payloadBytes > limits.maxPayloadBytesPerItem()) {
        throw new IllegalArgumentException("Item payload exceeds maxPayloadBytesPerItem");
      }
      totalBytes = Math.addExact(totalBytes, payloadBytes);
    }
    if (totalBytes > limits.maxTotalPayloadBytes()) {
      throw new IllegalArgumentException("DAG payload exceeds maxTotalPayloadBytes");
    }

    List<RoutedItem> routed = new ArrayList<>(request.items().size());
    for (int ordinal = 0; ordinal < request.items().size(); ordinal++) {
      DagItem item = request.items().get(ordinal);
      int payloadBytes = item.payload().getBytes(StandardCharsets.UTF_8).length;
      DagAdmission admission = policy.evaluate(new DagAdmission(
          request.planId(),
          item.capability(),
          capabilities.containsKey(item.capability()),
          false,
          item.capability().startsWith("shell."),
          request.items().size(),
          payloadBytes,
          totalBytes,
          limits));
      if (!admission.allowed()) {
        throw new IllegalArgumentException(
            "Capability is not admitted: " + item.capability() + " (" + admission.getReason() + ")");
      }
      routed.add(new RoutedItem(ordinal, item));
    }

    String planRoot = planRoot(request.planId());
    String requestRoot = requestRoot(request);
    exchange.setProperty(PLAN_ID_PROPERTY, request.planId());
    exchange.setProperty(PLAN_ROOT_PROPERTY, planRoot);
    exchange.setProperty(REQUEST_ROOT_PROPERTY, requestRoot);
    exchange.getMessage().setBody(routed);
  }

  private void bindEndpoint(Exchange exchange) {
    RoutedItem routed = exchange.getMessage().getBody(RoutedItem.class);
    String endpoint = endpoints.get(routed.item().capability());
    if (endpoint == null) {
      throw new IllegalArgumentException("Capability drift after admission");
    }
    exchange.getMessage().setHeader(ENDPOINT_HEADER, endpoint);
  }

  private void processItem(
      Exchange exchange, String expectedCapability, UnaryOperator<String> processor) {
    RoutedItem routed = exchange.getMessage().getBody(RoutedItem.class);
    DagItem item = routed.item();
    if (!expectedCapability.equals(item.capability())) {
      throw new IllegalStateException("Capability route mismatch");
    }
    String output = Objects.requireNonNull(processor.apply(item.payload()), "capability output");
    int outputBytes = output.getBytes(StandardCharsets.UTF_8).length;
    if (outputBytes > limits.maxPayloadBytesPerItem()) {
      throw new IllegalArgumentException("Capability output exceeds maxPayloadBytesPerItem");
    }
    exchange.getMessage().setBody(new DagOutput(
        routed.ordinal(),
        item.id(),
        item.capability(),
        Hashing.sha256(item.payload()),
        output,
        Hashing.sha256(output)));
  }

  @SuppressWarnings("unchecked")
  private void seal(Exchange exchange) {
    List<DagOutput> outputs = new ArrayList<>(exchange.getMessage().getBody(List.class));
    outputs.sort(Comparator.comparingInt(DagOutput::ordinal));
    String planId = exchange.getProperty(PLAN_ID_PROPERTY, String.class);
    String planRoot = exchange.getProperty(PLAN_ROOT_PROPERTY, String.class);
    String requestRoot = exchange.getProperty(REQUEST_ROOT_PROPERTY, String.class);
    String outputRoot = outputRoot(outputs);
    String receiptRoot = Hashing.sha256(
        Hashing.field(SCHEMA)
            + Hashing.field(planId)
            + Hashing.field(planRoot)
            + Hashing.field(policy.policyRoot())
            + Hashing.field(requestRoot)
            + Hashing.field(outputRoot)
            + Hashing.field(Integer.toString(outputs.size())));
    exchange.getMessage().setBody(new DagReceipt(
        SCHEMA,
        planId,
        planRoot,
        policy.policyRoot(),
        requestRoot,
        outputRoot,
        receiptRoot,
        limits.workerCount(),
        limits.queueSize(),
        List.copyOf(outputs)));
  }

  private String planRoot(String planId) {
    StringBuilder canonical = new StringBuilder();
    canonical.append(Hashing.field("codexpro.camel-cpu-dag.plan.v1"));
    canonical.append(Hashing.field(planId));
    canonical.append(Hashing.field(Integer.toString(limits.maxItems())));
    canonical.append(Hashing.field(Integer.toString(limits.maxPayloadBytesPerItem())));
    canonical.append(Hashing.field(Integer.toString(limits.maxTotalPayloadBytes())));
    canonical.append(Hashing.field(Integer.toString(limits.queueSize())));
    canonical.append(Hashing.field(Integer.toString(limits.workerCount())));
    canonical.append(Hashing.field(policy.policyRoot()));
    capabilityIds().forEach(id -> canonical.append(Hashing.field(id)));
    return Hashing.sha256(canonical.toString());
  }

  private static String requestRoot(DagRequest request) {
    StringBuilder canonical = new StringBuilder(Hashing.field(request.planId()));
    for (DagItem item : request.items()) {
      canonical.append(Hashing.field(item.id()));
      canonical.append(Hashing.field(item.capability()));
      canonical.append(Hashing.field(Hashing.sha256(item.payload())));
    }
    return Hashing.sha256(canonical.toString());
  }

  private static String outputRoot(List<DagOutput> outputs) {
    StringBuilder canonical = new StringBuilder();
    for (DagOutput output : outputs) {
      canonical.append(Hashing.field(Integer.toString(output.ordinal())));
      canonical.append(Hashing.field(output.id()));
      canonical.append(Hashing.field(output.capability()));
      canonical.append(Hashing.field(output.inputHash()));
      canonical.append(Hashing.field(output.outputHash()));
    }
    return Hashing.sha256(canonical.toString());
  }

  private Map<String, String> buildEndpoints(java.util.Set<String> ids) {
    Map<String, String> built = new LinkedHashMap<>();
    ids.stream().sorted().forEach(id -> built.put(id,
        "seda:cap-" + Hashing.sha256(id).substring(0, 16)
            + "?size=" + limits.queueSize()
            + "&concurrentConsumers=" + limits.workerCount()
            + "&blockWhenFull=true"
            + "&failIfNoConsumers=true"
            + "&waitForTaskToComplete=Always"));
    return Map.copyOf(built);
  }

  private static Map<String, UnaryOperator<String>> validateCapabilities(
      Map<String, UnaryOperator<String>> processors) {
    Objects.requireNonNull(processors, "capabilityProcessors");
    if (processors.isEmpty()) {
      throw new IllegalArgumentException("At least one capability processor is required");
    }
    Map<String, UnaryOperator<String>> validated = new LinkedHashMap<>();
    processors.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(entry -> {
      requireToken("capability id", entry.getKey());
      validated.put(entry.getKey(), Objects.requireNonNull(entry.getValue(), "capability processor"));
    });
    return validated;
  }

  private static void requireToken(String label, String value) {
    if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
      throw new IllegalArgumentException(label + " is invalid");
    }
  }

  @Override
  public void close() throws Exception {
    producer.stop();
    context.stop();
    splitWorkers.shutdownNow();
  }

  private record RoutedItem(int ordinal, DagItem item) {}
}
