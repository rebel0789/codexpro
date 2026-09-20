package com.synexia.codexpro.dag;

public final class DagAdmission {
  private final String planId;
  private final String capability;
  private final boolean registeredCapability;
  private final boolean endpointUriSupplied;
  private final boolean shellRequested;
  private final int itemCount;
  private final int payloadBytes;
  private final int totalPayloadBytes;
  private final int maxItems;
  private final int maxPayloadBytes;
  private final int maxTotalPayloadBytes;
  private String decision = "PENDING";
  private String reason = "unresolved";

  public DagAdmission(
      String planId,
      String capability,
      boolean registeredCapability,
      boolean endpointUriSupplied,
      boolean shellRequested,
      int itemCount,
      int payloadBytes,
      int totalPayloadBytes,
      DagLimits limits) {
    this.planId = planId;
    this.capability = capability;
    this.registeredCapability = registeredCapability;
    this.endpointUriSupplied = endpointUriSupplied;
    this.shellRequested = shellRequested;
    this.itemCount = itemCount;
    this.payloadBytes = payloadBytes;
    this.totalPayloadBytes = totalPayloadBytes;
    this.maxItems = limits.maxItems();
    this.maxPayloadBytes = limits.maxPayloadBytesPerItem();
    this.maxTotalPayloadBytes = limits.maxTotalPayloadBytes();
  }

  public String getPlanId() { return planId; }
  public String getCapability() { return capability; }
  public boolean isRegisteredCapability() { return registeredCapability; }
  public boolean isEndpointUriSupplied() { return endpointUriSupplied; }
  public boolean isShellRequested() { return shellRequested; }
  public int getItemCount() { return itemCount; }
  public int getPayloadBytes() { return payloadBytes; }
  public int getTotalPayloadBytes() { return totalPayloadBytes; }
  public int getMaxItems() { return maxItems; }
  public int getMaxPayloadBytes() { return maxPayloadBytes; }
  public int getMaxTotalPayloadBytes() { return maxTotalPayloadBytes; }
  public String getDecision() { return decision; }
  public String getReason() { return reason; }

  public void allow() {
    decision = "ALLOW";
    reason = "registered-bounded-data-plan";
  }

  public void deny(String deniedReason) {
    decision = "DENY";
    reason = deniedReason;
  }

  public boolean allowed() {
    return "ALLOW".equals(decision);
  }
}
