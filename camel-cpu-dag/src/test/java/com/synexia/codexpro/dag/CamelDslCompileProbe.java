package com.synexia.codexpro.dag;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.apache.camel.builder.RouteBuilder;
import org.apache.camel.model.FilterDefinition;
import org.apache.camel.model.RouteDefinition;

final class CamelDslCompileProbe extends RouteBuilder {
  private final ExecutorService workers = Executors.newFixedThreadPool(2);

  @Override
  public void configure() {
    RouteDefinition main = from("direct:dsl-probe-main").routeId("dsl-probe-main");
    main.process(exchange -> {});
    FilterDefinition filter = main.filter(exchange -> true);
    filter.to("direct:dsl-probe-filtered");
    filter.end();

    from("direct:dsl-probe-filtered")
        .routeId("dsl-probe-filtered")
        .multicast(new StableFanIn())
          .parallelProcessing()
          .executorService(workers)
          .synchronous()
          .stopOnException()
          .to("direct:dsl-probe-a", "direct:dsl-probe-b")
        .end()
        .process(exchange -> {});
    from("direct:dsl-probe-a").routeId("dsl-probe-a").process(exchange -> {});
    from("direct:dsl-probe-b").routeId("dsl-probe-b").process(exchange -> {});
  }
}
