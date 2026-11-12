import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STABLE_BRIDGE_SERVER_PATTERN = /^s[0-9a-f]{24}$/;

export interface BridgeIdentity {
  identity: string;
  serverName: string;
}

function canonicalPath(value: string): string {
  let resolved = path.resolve(value);
  // Resolve the existing ancestor too: creating a previously absent profile
  // below a junction must not change its identity on the next registration.
  let ancestor = resolved;
  const tail: string[] = [];
  while (true) {
    try { resolved = path.join(fs.realpathSync.native(ancestor), ...tail); break; }
    catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** A session owns its logical server; ephemeral ports/tokens never enter this identity. */
export function stableBridgeIdentity(agentDir: string, cwd: string, sessionId: string): BridgeIdentity {
  if (!sessionId.trim()) throw new Error("A Pi session identity is required for a stable bridge.");
  const identity = createHash("sha256").update(JSON.stringify([
    canonicalPath(agentDir), canonicalPath(cwd), sessionId,
  ])).digest("hex");
  return { identity, serverName: `s${identity.slice(0, 24)}` };
}

export function isBridgeOwnerDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH"; }
}

interface LeaseRow {
  identity: string;
  server_name: string;
  owner_id: string;
  pid: number;
}

function leaseTransaction<T>(agentDir: string, action: (db: DatabaseSync) => T): T {
  const directory = path.join(agentDir, "antigravity");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dbPath = path.join(directory, "bridge-leases.db");
  const db = new DatabaseSync(dbPath, { timeout: 250 });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS bridge_lease (identity TEXT PRIMARY KEY, server_name TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL, pid INTEGER NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

export interface NativeBridgeLease extends BridgeIdentity {
  readonly ownerId: string;
  /** Does not remove or steal a newer owner's lease. */
  release(): boolean;
}

// Resource reload can discard a closed host after a transient SQLite error.
// Keep only its conditional cleanup handle, never permission to steal a live
// owner. Symbol.for survives extension module reloads in this same process.
const RETIRED_LEASES_KEY = Symbol.for("pi-antigravity-native:retired-bridge-leases");
interface RetiredLease {
  lease: NativeBridgeLease;
  beforeRelease?: () => void;
}
function retiredLeases(): Map<string, RetiredLease> {
  const shared = globalThis as unknown as { [RETIRED_LEASES_KEY]?: Map<string, RetiredLease> };
  return shared[RETIRED_LEASES_KEY] ??= new Map();
}

/** Call only after that owner's HTTP transport and pending calls are closed. */
export function releaseRetiredNativeBridgeLease(lease: NativeBridgeLease, beforeRelease?: () => void): boolean {
  const previous = retiredLeases().get(lease.identity);
  const cleanup = beforeRelease ?? (previous?.lease.ownerId === lease.ownerId ? previous.beforeRelease : undefined);
  try {
    // Finish old schema/private-file cleanup BEFORE relinquishing ownership;
    // otherwise a late retry could delete a new instance's shared schema.
    cleanup?.();
    const released = lease.release();
    if (retiredLeases().get(lease.identity)?.lease.ownerId === lease.ownerId) retiredLeases().delete(lease.identity);
    return released;
  } catch (error) {
    retiredLeases().set(lease.identity, { lease, beforeRelease: cleanup });
    throw error;
  }
}

export function acquireNativeBridgeLease(options: {
  agentDir: string;
  cwd: string;
  sessionId: string;
  ownerId: string;
  pid?: number;
  isDeadPid?: (pid: number) => boolean;
  /** Runs under the same transaction, only after the prior process is proven dead. */
  onDeadOwner?: (ownerId: string, serverName: string) => void;
}): NativeBridgeLease {
  const { agentDir, cwd, sessionId, ownerId, pid = process.pid, isDeadPid = isBridgeOwnerDead, onDeadOwner } = options;
  if (!ownerId || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Pi bridge owner.");
  const logical = stableBridgeIdentity(agentDir, cwd, sessionId);
  const retired = retiredLeases().get(logical.identity);
  if (retired) releaseRetiredNativeBridgeLease(retired.lease, retired.beforeRelease);
  leaseTransaction(agentDir, db => {
    const existing = db.prepare("SELECT * FROM bridge_lease WHERE identity = ? OR server_name = ?")
      .get(logical.identity, logical.serverName) as LeaseRow | undefined;
    if (existing) {
      if (existing.identity !== logical.identity || existing.server_name !== logical.serverName) {
        throw new Error("Pi bridge logical identity collision; registration refused.");
      }
      if (existing.owner_id === ownerId && existing.pid === pid) return;
      if (!isDeadPid(existing.pid)) {
        throw new Error(`Pi session bridge is already owned by a live or unverified process (PID ${existing.pid}); close that session host before reopening it. Lease: ${path.join(agentDir, "antigravity", "bridge-leases.db")}`);
      }
      onDeadOwner?.(existing.owner_id, existing.server_name);
    }
    db.prepare("INSERT OR REPLACE INTO bridge_lease(identity, server_name, owner_id, pid) VALUES (?, ?, ?, ?)")
      .run(logical.identity, logical.serverName, ownerId, pid);
  });
  return {
    ...logical, ownerId,
    release: () => leaseTransaction(agentDir, db =>
      Number(db.prepare("DELETE FROM bridge_lease WHERE identity = ? AND owner_id = ? AND pid = ?")
        .run(logical.identity, ownerId, pid).changes) === 1),
  };
}

/** A dead private workspace may share its logical server with a newer owner. */
export function removeDeadBridgeLease(
  agentDir: string, serverName: string, ownerId: string,
  isDeadPid: (pid: number) => boolean, removeSchema: () => void,
): boolean {
  return leaseTransaction(agentDir, db => {
    const row = db.prepare("SELECT * FROM bridge_lease WHERE server_name = ?").get(serverName) as LeaseRow | undefined;
    if (!row || row.owner_id !== ownerId || !isDeadPid(row.pid)) return false;
    removeSchema();
    db.prepare("DELETE FROM bridge_lease WHERE identity = ? AND owner_id = ?").run(row.identity, ownerId);
    return true;
  });
}
