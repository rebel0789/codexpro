package com.synexia.codexpro.dag;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.apache.camel.CamelExecutionException;
import org.junit.jupiter.api.Test;

class CamelCpuDagTest {
  @Test
  void routesInParallelButSealsInStableInputOrder() throws Exception {
    Map<String, UnaryOperator<String>> processors = Map.of(
        "inventory.identity", value -> {
          if (value.equals("first")) {
            try {
              Thread.sleep(30);
            } catch (InterruptedException interrupted) {
              Thread.currentThread().interrupt();
              throw new IllegalStateException(interrupted);
            }
          }
          return value;
        },
        "hash.sha256", Hashing::sha256);
    DagLimits limits = new DagLimits(16, 1024, 4096, 4, 2);
    DagRequest request = new DagRequest("inventory-proof", List.of(
        new DagItem("a", "inventory.identity", "first"),
        new DagItem("b", "hash.sha256", "second"),
        new DagItem("c", "inventory.identity", "third")));

    try (CamelCpuDag dag = new CamelCpuDag(limits, processors)) {
      DagReceipt first = dag.execute(request);
      DagReceipt replay = dag.execute(request);
      assertEquals(List.of("a", "b", "c"), first.outputs().stream().map(DagOutput::id).toList());
      assertEquals(first.receiptRoot(), replay.receiptRoot());
      assertEquals(2, first.workerLimit());
      assertEquals(4, first.queueLimit());
      assertTrue(first.outputs().stream().allMatch(output -> output.outputHash().length() == 64));
    }
  }

  @Test
  void rejectsUnknownCapabilityBeforeRouting() throws Exception {
    try (CamelCpuDag dag = new CamelCpuDag(
        new DagLimits(4, 128, 256, 2, 1),
        Map.of("inventory.identity", value -> value))) {
      CamelExecutionException failure = assertThrows(CamelExecutionException.class, () ->
          dag.execute(new DagRequest("bad-plan", List.of(
              new DagItem("x", "shell.unrestricted", "whoami")))));
      assertTrue(rootMessage(failure).contains("not admitted"));
    }
  }

  @Test
  void rejectsPayloadOverLimitAndBindsPayloadToReceipt() throws Exception {
    try (CamelCpuDag dag = new CamelCpuDag(
        new DagLimits(4, 8, 16, 2, 1),
        Map.of("inventory.identity", value -> value))) {
      assertThrows(CamelExecutionException.class, () -> dag.execute(new DagRequest(
          "too-large", List.of(new DagItem("x", "inventory.identity", "123456789")))));

      DagReceipt one = dag.execute(new DagRequest(
          "proof", List.of(new DagItem("x", "inventory.identity", "one"))));
      DagReceipt two = dag.execute(new DagRequest(
          "proof", List.of(new DagItem("x", "inventory.identity", "two"))));
      assertNotEquals(one.requestRoot(), two.requestRoot());
      assertNotEquals(one.receiptRoot(), two.receiptRoot());
    }
  }

  private static String rootMessage(Throwable throwable) {
    Throwable current = throwable;
    while (current.getCause() != null) {
      current = current.getCause();
    }
    return String.valueOf(current.getMessage());
  }
}
