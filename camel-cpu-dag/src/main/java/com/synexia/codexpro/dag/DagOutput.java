package com.synexia.codexpro.dag;

public record DagOutput(
    int ordinal,
    String id,
    String capability,
    String inputHash,
    String output,
    String outputHash) {}
