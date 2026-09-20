package com.synexia.codexpro.dag;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.kie.api.builder.Message;
import org.kie.api.builder.Results;
import org.kie.api.runtime.StatelessKieSession;
import org.kie.internal.utils.KieHelper;

final class DagPolicy {
  static final String POLICY_RESOURCE = "com/synexia/codexpro/dag/dag-admission.drl";
  static final String POLICY_VERSION = "codexpro.dag-admission.v1";

  private final StatelessKieSession session;
  private final String policyRoot;

  DagPolicy() {
    String rules = readRules();
    KieHelper helper = new KieHelper().addContent(rules, "src/main/resources/" + POLICY_RESOURCE);
    Results verification = helper.verify();
    if (verification.hasMessages(Message.Level.ERROR)) {
      throw new IllegalStateException("DAG admission rules failed verification: " + verification.getMessages(Message.Level.ERROR));
    }
    this.session = helper.build().newStatelessKieSession();
    this.policyRoot = Hashing.sha256(Hashing.field(POLICY_VERSION) + Hashing.field(rules));
  }

  synchronized DagAdmission evaluate(DagAdmission admission) {
    session.execute(admission);
    if ("PENDING".equals(admission.getDecision())) {
      admission.deny("no-rule-produced-a-decision");
    }
    return admission;
  }

  String policyRoot() {
    return policyRoot;
  }

  private static String readRules() {
    ClassLoader loader = DagPolicy.class.getClassLoader();
    try (InputStream input = loader.getResourceAsStream(POLICY_RESOURCE)) {
      if (input == null) throw new IllegalStateException("Missing DAG admission rules: " + POLICY_RESOURCE);
      return new String(input.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException error) {
      throw new IllegalStateException("Unable to read DAG admission rules", error);
    }
  }
}
