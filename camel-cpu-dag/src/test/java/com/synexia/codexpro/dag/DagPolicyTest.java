package com.synexia.codexpro.dag;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class DagPolicyTest {
  private static final DagLimits LIMITS = new DagLimits(4, 32, 64, 2, 1);

  @Test
  void allowsOnlyRegisteredBoundedDataPlans() {
    DagPolicy policy = new DagPolicy();
    DagAdmission allowed = policy.evaluate(new DagAdmission(
        "plan", "inventory.identity", true, false, false, 2, 8, 16, LIMITS));
    assertTrue(allowed.allowed());
    assertEquals("registered-bounded-data-plan", allowed.getReason());
    assertEquals(64, policy.policyRoot().length());
  }

  @Test
  void endpointUriAndUnknownCapabilityFailClosed() {
    DagPolicy policy = new DagPolicy();
    DagAdmission endpoint = policy.evaluate(new DagAdmission(
        "plan", "inventory.identity", true, true, false, 1, 8, 8, LIMITS));
    DagAdmission unknown = policy.evaluate(new DagAdmission(
        "plan", "made.up", false, false, false, 1, 8, 8, LIMITS));
    assertFalse(endpoint.allowed());
    assertEquals("endpoint-uri-from-planner-forbidden", endpoint.getReason());
    assertFalse(unknown.allowed());
    assertEquals("capability-not-admitted", unknown.getReason());
  }

  @Test
  void overflowFailsClosed() {
    DagAdmission overflow = new DagPolicy().evaluate(new DagAdmission(
        "plan", "inventory.identity", true, false, false, 5, 8, 40, LIMITS));
    assertFalse(overflow.allowed());
    assertEquals("item-count-overflow", overflow.getReason());
  }
}
