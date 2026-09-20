package com.synexia.codexpro.dag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class Hashing {
  private Hashing() {}

  static String sha256(String value) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      return java.util.HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 unavailable", impossible);
    }
  }

  static String field(String value) {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    return bytes.length + ":" + value + "\n";
  }
}
