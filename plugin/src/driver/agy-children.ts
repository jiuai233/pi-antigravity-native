import { spawnSync } from "node:child_process";

/**
 * Tracking and process-group cleanup for agy subprocesses.
 *
 * agy runs as a process tree; signaling only the direct child (node's
 * default timeout/kill behavior) leaves grandchildren running. Worse, when
 * pi itself dies first — closing a terminal pane delivers SIGHUP — pending
 * timeouts die with it and nothing kills the child: a wedged `agy mcp remove`
 * from shutdown could linger forever.
 *
 * POSIX children are spawned detached (own process group), so one negative-pid
 * SIGKILL reaps the whole tree. Windows children stay attached to the host
 * process context so PowerShell grandchildren do not open visible windows;
 * taskkill /T still reaps their whole tree. Exit/SIGHUP hooks sweep every
 * tracked process synchronously before the host goes away.
 */

const AGY_CHILDREN_REGISTRY_SYMBOL = Symbol.for("pi-antigravity.agy-children");
const PROCESS_OWNER = Symbol.for("pi-antigravity.agy-process-owner");

export interface AgyChildrenRegistry {
  /** Legacy modules can still sweep these fields during session shutdown. */
  live: Set<number>;
  owners?: Map<number, symbol>;
  hooksInstalled: boolean;
  /** Kept separate so an already-loaded legacy sweep cannot reap new trees. */
  ownedTrees?: Map<number, symbol>;
  ownedHooksInstalled?: boolean;
}

/** Host effects and registry scope can be isolated by offline callers. */
export interface AgyChildrenHost {
  registryScope: object;
  process: Pick<NodeJS.Process, "platform" | "kill" | "on">;
  spawnSync: typeof spawnSync;
}

const defaultHost: AgyChildrenHost = { registryScope: globalThis, process, spawnSync };

export function getAgyChildrenRegistry(host: AgyChildrenHost = defaultHost): AgyChildrenRegistry {
  const globalObj = host.registryScope as {
    [AGY_CHILDREN_REGISTRY_SYMBOL]?: AgyChildrenRegistry;
  };
  if (!globalObj[AGY_CHILDREN_REGISTRY_SYMBOL]) {
    globalObj[AGY_CHILDREN_REGISTRY_SYMBOL] = {
      live: new Set<number>(),
      hooksInstalled: false,
    };
  }
  return globalObj[AGY_CHILDREN_REGISTRY_SYMBOL];
}

export interface TrackableChild {
  pid?: number;
}

export function killProcessTreeSync(pid: number, host: AgyChildrenHost = defaultHost): void {
  if (host.process.platform === "win32") {
    try {
      host.spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Process may already be gone or taskkill unavailable.
    }
    return;
  }

  try {
    host.process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Process group may already be gone; try leader as fallback.
  }
  try {
    host.process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

export function trackAgyChild(
  child: TrackableChild, owner?: symbol, host: AgyChildrenHost = defaultHost,
): void {
  if (child.pid === undefined) return;
  const registry = getAgyChildrenRegistry(host);
  registry.live.delete(child.pid);
  registry.owners?.delete(child.pid);
  registry.ownedTrees ??= new Map();
  registry.ownedTrees.set(child.pid, owner ?? PROCESS_OWNER);
}

export function untrackAgyChild(child: TrackableChild, host: AgyChildrenHost = defaultHost): void {
  if (child.pid === undefined) return;
  const registry = getAgyChildrenRegistry(host);
  registry.live.delete(child.pid);
  registry.owners?.delete(child.pid);
  registry.ownedTrees?.delete(child.pid);
}

/** Send a signal to a tracked process tree without removing it from tracking. */
export function signalAgyTree(
  child: TrackableChild, signal: NodeJS.Signals, host: AgyChildrenHost = defaultHost,
): void {
  if (child.pid === undefined) return;
  if (host.process.platform === "win32") {
    // Windows has no process-group SIGTERM equivalent; callers escalate with taskkill.
    return;
  }
  try {
    host.process.kill(-child.pid, signal);
    return;
  } catch {
    // Process group may already be gone; try the leader.
  }
  try {
    host.process.kill(child.pid, signal);
  } catch {
    // Already exited.
  }
}

/** Synchronously terminate a child's whole process tree. */
export function killAgyTree(child: TrackableChild, host: AgyChildrenHost = defaultHost): void {
  if (child.pid === undefined) return;
  untrackAgyChild(child, host);
  killProcessTreeSync(child.pid, host);
}

/** Reap this runtime's remaining trees, including logically finished one-shot turns. */
export function killOwnedAgyTrees(owner: symbol, host: AgyChildrenHost = defaultHost): void {
  const registry = getAgyChildrenRegistry(host);
  for (const [pid, childOwner] of registry.ownedTrees ?? []) {
    if (childOwner !== owner) continue;
    killAgyTree({ pid }, host);
  }
}

/** Synchronously terminate every tracked process tree. Signal-handler safe. */
export function killAllAgyTrees(host: AgyChildrenHost = defaultHost): void {
  const registry = getAgyChildrenRegistry(host);
  const pids = new Set([...registry.live, ...(registry.owners?.keys() ?? []), ...(registry.ownedTrees?.keys() ?? [])]);
  for (const pid of pids) killProcessTreeSync(pid, host);
  registry.live.clear();
  registry.owners?.clear();
  registry.ownedTrees?.clear();
}

/**
 * Reap agy trees when this pi process dies. `exit` covers graceful
 * shutdown; SIGHUP reaps our children without terminating the host process
 * so Pi's async graceful shutdown/session_shutdown is not preempted.
 */
export function installAgyDeathHooks(host: AgyChildrenHost = defaultHost): void {
  const registry = getAgyChildrenRegistry(host);
  if (registry.ownedHooksInstalled) return;
  registry.ownedHooksInstalled = true;
  registry.hooksInstalled = true;
  host.process.on("exit", () => killAllAgyTrees(host));
  host.process.on("SIGHUP", () => killAllAgyTrees(host));
}
