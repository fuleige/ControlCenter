#!/usr/bin/env node
import { ensureAdminToken, readAdminToken, rotateAdminToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { ControlDatabase } from "./database.js";

function usage(): never {
  console.error("Usage: controller-center-admin <admin-token show|admin-token rotate|sessions revoke-all>");
  process.exit(2);
}

const config = loadConfig();
const database = new ControlDatabase(config.databasePath, { recoverRuntimeState: false });

try {
  const [resource, action, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !resource || !action) usage();
  ensureAdminToken(database, config.adminTokenPath, config.adminToken);
  if (resource === "admin-token" && action === "show") {
    process.stdout.write(`${readAdminToken(config.adminTokenPath)}\n`);
  } else if (resource === "admin-token" && action === "rotate") {
    process.stdout.write(`${rotateAdminToken(database, config.adminTokenPath)}\n`);
  } else if (resource === "sessions" && action === "revoke-all") {
    const count = database.revokeAllAdminSessions(new Date().toISOString());
    process.stdout.write(`Revoked ${count} admin session(s).\n`);
  } else {
    usage();
  }
} finally {
  database.close();
}
