package com.synexia.codexpro.dag;

public record DagLimits(
    int maxItems,
    int maxPayloadBytesPerItem,
    int maxTotalPayloadBytes,
    int queueSize,
    int workerCount) {

  public DagLimits {
    if (maxItems < 1 || maxPayloadBytesPerItem < 1 || maxTotalPayloadBytes < 1) {
      throw new IllegalArgumentException("Payload limits must be positive");
    }
    if (queueSize < 1 || workerCount < 1 || workerCount > 8) {
      throw new IllegalArgumentException("Queue size must be positive and workers must be between 1 and 8");
    }
  }

  public static DagLimits boundedDefaults() {
    int cpus = Runtime.getRuntime().availableProcessors();
    int workers = Math.max(1, Math.min(8, (int) Math.floor(cpus * 0.8d)));
    return new DagLimits(512, 65_536, 4_194_304, 64, workers);
  }
}
