package com.synexia.codexpro.dag;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;

public final class CamelCpuDagMain {
  private CamelCpuDagMain() {}

  public static void main(String[] args) throws Exception {
    ObjectMapper mapper = new ObjectMapper();
    byte[] input = System.in.readAllBytes();
    if (input.length == 0) {
      throw new IllegalArgumentException("Expected one DagRequest JSON document on stdin");
    }
    DagRequest request = mapper.readValue(new String(input, StandardCharsets.UTF_8), DagRequest.class);
    try (CamelCpuDag dag = CamelCpuDag.createDefault()) {
      DagReceipt receipt = dag.execute(request);
      mapper.writeValue(System.out, receipt);
      System.out.write('\n');
    }
  }
}
