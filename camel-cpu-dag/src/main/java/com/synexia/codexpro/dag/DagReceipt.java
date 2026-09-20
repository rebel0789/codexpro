package com.synexia.codexpro.dag;

import java.util.List;

public record DagReceipt(
    String schema,
    String planId,
    String planRoot,
    String policyRoot,
    String requestRoot,
    String outputRoot,
    String receiptRoot,
    int workerLimit,
    int queueLimit,
    List<DagOutput> outputs) {}
