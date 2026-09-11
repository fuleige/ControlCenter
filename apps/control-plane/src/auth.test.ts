import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptEnrollmentToken, encryptEnrollmentToken, ensureAdminToken, ensureEnrollmentDisplayKey, hashSecret, parseOpaqueToken, rotateAdminToken, secretMatches } from "./auth.js";
import { ControlDatabase } from "./database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("control-plane secrets", () => {
  it("persists a local-only admin token and rotates its database hash", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-secret-test-"));
    directories.push(directory);
    const database = new ControlDatabase(path.join(directory, "test.db"), { recoverRuntimeState: false });
    const tokenPath = path.join(directory, "secrets", "admin-token");
    const first = ensureAdminToken(database, tokenPath, null);
    expect(first).toMatch(/^cca_/);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(first);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(database.getAdminTokenHash()).toBe(hashSecret(first));
    const second = rotateAdminToken(database, tokenPath);
    expect(second).not.toBe(first);
    expect(database.getAdminTokenHash()).toBe(hashSecret(second));
    expect(secretMatches(second, database.getAdminTokenHash()!)).toBe(true);
    database.close();
  });

  it("parses only the requested opaque token family", () => {
    const token = "cce_00000000-0000-4000-8000-000000000000.abcdefghijklmnopqrstuvwxyzABCDEFG_123456789";
    expect(parseOpaqueToken(token, "cce")?.id).toBe("00000000-0000-4000-8000-000000000000");
    expect(parseOpaqueToken(token, "ccn")).toBeNull();
  });

  it("encrypts displayable enrollment tokens with a persistent local key", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "control-plane-enrollment-key-test-"));
    directories.push(directory);
    const keyPath = path.join(directory, "secrets", "enrollment-display-key");
    const firstKey = ensureEnrollmentDisplayKey(keyPath);
    const token = "cce_00000000-0000-4000-8000-000000000000.abcdefghijklmnopqrstuvwxyzABCDEFG_123456789";
    const encrypted = encryptEnrollmentToken(token, firstKey);
    expect(encrypted).not.toContain(token);
    expect(decryptEnrollmentToken(encrypted, ensureEnrollmentDisplayKey(keyPath))).toBe(token);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });
});
