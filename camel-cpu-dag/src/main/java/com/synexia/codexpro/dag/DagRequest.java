package com.synexia.codexpro.dag;

import java.util.List;

public record DagRequest(String planId, List<DagItem> items) {}
