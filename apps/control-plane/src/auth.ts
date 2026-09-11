import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ControlDatabase } from "./database.js";

export const ADMIN_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const ENROLLMENT_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secretMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createOpaqueToken(prefix: "ccs" | "cce" | "ccn"): { id: string; token: string; tokenHash: string } {
  const id = randomUUID();
  const token = `${prefix}_${id}.${randomSecret()}`;
  return { id, token, tokenHash: hashSecret(token) };
}

export function parseOpaqueToken(value: string, prefix: "ccs" | "cce" | "ccn"): { id: string; token: string } | null {
  const match = new RegExp(`^${prefix}_([0-9a-f-]{36})\\.([A-Za-z0-9_-]{32,})$`, "i").exec(value);
  return match ? { id: match[1]!.toLowerCase(), token: value } : null;
}

export function createAdminToken(): string {
  return `cca_${randomSecret()}`;
}

export function readAdminToken(tokenPath: string): string {
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error(`Admin token file is empty: ${tokenPath}`);
  return token;
}

function persistLocalSecret(tokenPath: string, token: string): void {
  mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(tokenPath), 0o700);
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, tokenPath);
  chmodSync(tokenPath, 0o600);
}

export function ensureEnrollmentDisplayKey(keyPath: string): Buffer {
  try {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64url");
    if (key.length !== 32) throw new Error(`Enrollment display key must contain 32 bytes: ${keyPath}`);
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    persistLocalSecret(keyPath, key.toString("base64url"));
    return key;
  }
}

export function encryptEnrollmentToken(value: string, key: Buffer): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", initializationVector.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptEnrollmentToken(value: string, key: Buffer): string {
  const [version, initializationVector, authenticationTag, encrypted] = value.split(".");
  if (version !== "v1" || !initializationVector || !authenticationTag || !encrypted) {
    throw new Error("Unsupported enrollment token ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(initializationVector, "base64url"));
  decipher.setAuthTag(Buffer.from(authenticationTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export function ensureAdminToken(database: ControlDatabase, tokenPath: string, bootstrapToken?: string | null): string {
  let token: string;
  try {
    token = readAdminToken(tokenPath);
    chmodSync(tokenPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = bootstrapToken?.trim() || createAdminToken();
    persistLocalSecret(tokenPath, token);
  }
  database.setAdminTokenHash(hashSecret(token), new Date().toISOString());
  return token;
}

export function rotateAdminToken(database: ControlDatabase, tokenPath: string): string {
  const token = createAdminToken();
  persistLocalSecret(tokenPath, token);
  const changedAt = new Date().toISOString();
  database.setAdminTokenHash(hashSecret(token), changedAt);
  database.revokeAllAdminSessions(changedAt);
  return token;
}
