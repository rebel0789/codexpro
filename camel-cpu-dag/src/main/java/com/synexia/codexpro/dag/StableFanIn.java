package com.synexia.codexpro.dag;

import java.util.ArrayList;
import java.util.List;
import org.apache.camel.AggregationStrategy;
import org.apache.camel.Exchange;

final class StableFanIn implements AggregationStrategy {
  @Override
  @SuppressWarnings("unchecked")
  public Exchange aggregate(Exchange accumulated, Exchange incoming) {
    DagOutput output = incoming.getMessage().getBody(DagOutput.class);
    if (accumulated == null) {
      List<DagOutput> outputs = new ArrayList<>();
      outputs.add(output);
      incoming.getMessage().setBody(outputs);
      return incoming;
    }
    ((List<DagOutput>) accumulated.getMessage().getBody(List.class)).add(output);
    return accumulated;
  }
}
