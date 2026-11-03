import type { AgyPiBridge } from "./bridge.ts";

export interface BridgeLifecycleDeps {
  bridge: AgyPiBridge;
  bridgeToken: string;
  addMcpServer: (serverName: string, url: string, token: string) => Promise<void>;
  removeMcpServer: (serverName: string) => Promise<void>;

}

export interface BridgeLifecycleManager {
  readonly isRegistered: () => boolean;
  readonly isRunning: () => boolean;
  readonly ensureRegistered: (notify?: (message: string) => void) => Promise<boolean>;
  readonly teardown: () => Promise<void>;
  readonly registrationGeneration: () => number;
  readonly processRevision: () => string;
}

export function createBridgeLifecycleManager(deps: BridgeLifecycleDeps): BridgeLifecycleManager {
  let registered = false;
  let generation = 0;

  return {
    isRegistered: () => registered,
    isRunning: () => deps.bridge.running,
    registrationGeneration: () => generation,
    processRevision: () => `${generation}:${deps.bridge.catalogRevision}`,

    ensureRegistered: async (notify?: (message: string) => void) => {
      if (registered) return true;

      try {
        if (!deps.bridge.running) {
          await deps.bridge.start();
        }
        const url = deps.bridge.url;
        if (!url) throw new Error("pi-tool bridge did not expose a URL after start.");
        await deps.addMcpServer(deps.bridge.serverName, url, deps.bridgeToken);
        deps.bridge.refreshTools();
        registered = true;
        generation += 1;
        return true;
      } catch (error) {
        registered = false;
        const message = error instanceof Error ? error.message : String(error);
        const warning = `antigravity: pi-tool bridge unavailable (${message}).`;
        if (notify) {
          notify(warning);
        } else {
        }
        return false;
      }
    },

    teardown: async () => {
      if (!registered && !deps.bridge.running) return;
      const changed = registered || deps.bridge.running;
      registered = false;
      try {
        await deps.removeMcpServer(deps.bridge.serverName);
      } catch {
        // Registration may already be gone.
      }
      if (deps.bridge.running) {
        await deps.bridge.close();
      }
      if (changed) generation += 1;
    },

  };
}
