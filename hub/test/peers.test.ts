import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadPeerRegistry } from "../src/federation/peers.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";

function tmpPath(suffix = "") {
  return path.join(os.tmpdir(), `poutine-peers-${Date.now()}-${suffix}`);
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

describe("loadPeerRegistry", () => {
  it("returns empty registry when file does not exist", () => {
    const missing = tmpPath("missing.yaml");
    // Ensure it doesn't exist
    if (fs.existsSync(missing)) fs.unlinkSync(missing);

    const registry = loadPeerRegistry(missing, "fallback-id");
    expect(registry.instanceId).toBe("fallback-id");
    expect(registry.peers.size).toBe(0);
  });

  it("parses a valid peer and uses the fallback instance ID", () => {
    const keyPath = tmpPath("peer-pub.pem");
    const yamlPath = tmpPath("peers.yaml");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      writeYaml(
        yamlPath,
        `peers:\n  - id: "test-bob"\n    url: "https://bob.example"\n    public_key: "ed25519:${publicKeyBase64}"\n`,
      );

      const registry = loadPeerRegistry(yamlPath, "test-alice");
      expect(registry.instanceId).toBe("test-alice");
      expect(registry.peers.size).toBe(1);

      const bob = registry.peers.get("test-bob");
      expect(bob).toBeDefined();
      expect(bob!.id).toBe("test-bob");
      expect(bob!.url).toBe("https://bob.example");
      expect(bob!.publicKeySpec).toBe(`ed25519:${publicKeyBase64}`);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });

  it("skips a peer whose id matches the local instance ID", () => {
    const keyPath = tmpPath("self.pem");
    const yamlPath = tmpPath("self-peers.yaml");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      writeYaml(
        yamlPath,
        [
          "peers:",
          "  - id: alice",
          "    url: https://alice.example",
          `    public_key: "ed25519:${publicKeyBase64}"`,
          "  - id: bob",
          "    url: https://bob.example",
          `    public_key: "ed25519:${publicKeyBase64}"`,
        ].join("\n"),
      );

      const registry = loadPeerRegistry(yamlPath, "alice");
      expect(registry.peers.has("alice")).toBe(false);
      expect(registry.peers.has("bob")).toBe(true);
      expect(registry.peers.size).toBe(1);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });

  it("strips trailing slashes from peer URLs", () => {
    const keyPath = tmpPath("trailing-slash.pem");
    const yamlPath = tmpPath("trailing-slash-peers.yaml");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      writeYaml(
        yamlPath,
        `peers:\n  - id: "bob"\n    url: "https://bob.example///"\n    public_key: "ed25519:${publicKeyBase64}"\n`,
      );

      const registry = loadPeerRegistry(yamlPath, "alice");
      const bob = registry.peers.get("bob");
      expect(bob!.url).toBe("https://bob.example");
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });

  it("drops a peer with an invalid public_key and loads the rest", () => {
    const keyPath = tmpPath("mixed.pem");
    const yamlPath = tmpPath("mixed-peers.yaml");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      writeYaml(
        yamlPath,
        [
          "peers:",
          "  - id: bad-peer",
          "    url: https://bad.example",
          "    public_key: ed25519:notvalidbase64!!!!",
          "  - id: good-peer",
          `    url: https://good.example`,
          `    public_key: "ed25519:${publicKeyBase64}"`,
        ].join("\n"),
      );

      const registry = loadPeerRegistry(yamlPath, "fallback");
      expect(registry.peers.has("bad-peer")).toBe(false);
      expect(registry.peers.has("good-peer")).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });

  it("reload() picks up changes to the file", () => {
    const keyPath = tmpPath("reload.pem");
    const yamlPath = tmpPath("reload-peers.yaml");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      // Start with no peers
      writeYaml(yamlPath, `peers: []\n`);

      const registry = loadPeerRegistry(yamlPath, "alice");
      expect(registry.peers.size).toBe(0);

      // Add a peer to the file
      writeYaml(
        yamlPath,
        `peers:\n  - id: newpeer\n    url: https://new.example\n    public_key: "ed25519:${publicKeyBase64}"\n`,
      );

      registry.reload();
      expect(registry.peers.size).toBe(1);
      expect(registry.peers.has("newpeer")).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });
});
