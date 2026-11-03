// Owns the Pi-tool bridge: the loopback MCP server, its registration in the
// native workspace, and the tool projection for each SDK request. The bridge
// only exists while an Antigravity model is selected.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgyProcessProfile, readAgyProcessProfile } from "../driver/agy-profile.ts";
import { bridgeToolName } from "../native/native-tool-names.ts";
import { cliServerName, NativeWorkspaceRegistration } from "../native/native-workspace.ts";
import type { AntigravityRuntime } from "../runtime/runtime.ts";
import { AgyPiBridge, type PiToolInfo } from "./bridge.ts";
import { type BridgeLifecycleManager, createBridgeLifecycleManager } from "./bridge-lifecycle.ts";
import { nonWorkspaceSkills, type SkillLite, usableSkillCatalog } from "./skills.ts";
import { ToolProjection } from "./tool-projection.ts";

// One process-wide exit hook disposes the workspaces that are live. A load that
// never selects a workspace (Pi Web builds model-only runtimes, never shut down)
// then leaves no listener behind holding the whole extension instance.
const LIVE_WORKSPACES_KEY = Symbol.for("pi-antigravity-native:live-workspaces");
function liveWorkspaces(): Set<NativeWorkspaceRegistration> {
  const registry = globalThis as unknown as { [LIVE_WORKSPACES_KEY]?: Set<NativeWorkspaceRegistration> };
  if (!registry[LIVE_WORKSPACES_KEY]) {
    const live = new Set<NativeWorkspaceRegistration>();
    registry[LIVE_WORKSPACES_KEY] = live;
    process.once("exit", () => { for (const workspace of live) workspace.dispose(); });
  }
  return registry[LIVE_WORKSPACES_KEY];
}

/** Pi's loaded skills, minus those with model invocation disabled. */
export function captureSkills(skills: unknown): SkillLite[] | undefined {
  if (!Array.isArray(skills)) return undefined;
  return skills
    .map((skill) => skill as Partial<SkillLite> & { disableModelInvocation?: boolean })
    .filter(
      (skill) => skill.disableModelInvocation !== true && typeof skill.filePath === "string",
    )
    .map((skill) => ({
      name: String(skill.name),
      description: String(skill.description ?? ""),
      filePath: String(skill.filePath),
      baseDir: String(skill.baseDir ?? path.dirname(String(skill.filePath))),
    }));
}

type BridgeRuntime = Pick<AntigravityRuntime, "pushBridgeCall" | "finishBridgeCall">;

export class BridgeHost {
  readonly bridge: AgyPiBridge;
  readonly projection: ToolProjection;
  readonly processRevision: () => string;
  readonly #id: string;
  readonly #serverName: string;
  readonly #manager: BridgeLifecycleManager;
  #workspace: NativeWorkspaceRegistration | undefined;
  #skills: SkillLite[] = [];

  /** sessionCwd: workspace-local skills there are discovered by agy itself. */
  constructor(runtime: BridgeRuntime, sessionCwd: () => string | undefined) {
    this.#id = `p${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.#serverName = cliServerName(this.#id);
    const bridge = new AgyPiBridge(this.#serverName);
    const bridgeToken = randomUUID();
    bridge.requireToken(bridgeToken);
    bridge.setToolPrefix("");
    bridge.setOnCall((call) => runtime.pushBridgeCall({ ...call,
      nativeServerName: this.#serverName, nativeToolName: bridgeToolName(this.#serverName, call.tool, ""),
    }));
    bridge.setOnSettled((id) => runtime.finishBridgeCall(id));
    this.bridge = bridge;
    this.#manager = createBridgeLifecycleManager({
      bridge,
      bridgeToken,
      addMcpServer: async (_serverName, url, token) => {
        if (!this.#workspace) throw new Error("Pi workspace must be selected before MCP registration.");
        this.#workspace.registerMcpServer(url, token);
      },
      removeMcpServer: async () => {
        this.#dropWorkspace();
      },
    });
    this.processRevision = this.#manager.processRevision;
    this.projection = new ToolProjection({
      bridge,
      skills: () => usableSkillCatalog(nonWorkspaceSkills(this.#skills, sessionCwd())),
    });
  }

  get pendingCount(): number {
    return this.bridge.pendingCount;
  }

  cancelPending(reason: string): void {
    this.bridge.cancelPending(reason);
  }

  /** Refreshed per turn from before_agent_start, so /reload is respected. */
  setSkills(skills: unknown): void {
    const captured = captureSkills(skills);
    if (captured) this.#skills = captured;
  }

  refreshSkillTools(): void {
    this.projection.refreshSkillTools();
  }

  async ensureRegistered(ui?: ExtensionUIContext, cwd = process.cwd()): Promise<void> {
    const resolvedCwd = path.resolve(cwd);
    if (this.#workspace && this.#workspace.cwd !== resolvedCwd) {
      await this.#manager.teardown();
      this.#dropWorkspace();
    }
    if (!this.#workspace) {
      this.#workspace = new NativeWorkspaceRegistration({
        cwd: resolvedCwd, id: this.#id, serverName: this.#serverName, agentDir: getAgentDir(),
      });
      liveWorkspaces().add(this.#workspace);
    }
    const registered = await this.#manager.ensureRegistered((warning) => ui?.notify(warning, "warning"));
    if (!registered) throw new Error("Pi workspace bridge could not be registered.");
  }

  async prepareAgent(systemPrompt: string, declaredTools: readonly PiToolInfo[]) {
    if (!this.#workspace || !this.#manager.isRegistered()) {
      throw new Error("Pi workspace bridge has not been initialized.");
    }
    return this.projection.prepare(this.#workspace, systemPrompt, declaredTools);
  }

  async teardown(): Promise<void> {
    await this.#manager.teardown();
    this.#dropWorkspace();
  }

  processProfile(): AgyProcessProfile {
    const registered = this.#manager.isRegistered();
    return {
      ...readAgyProcessProfile(),
      mcpDirectory: registered ? this.#workspace?.directory : undefined,
      bridgeBootstrap: registered ? this.#workspace?.routingHint : undefined,
    };
  }

  describe(): string {
    return `running=${this.#manager.isRunning()} registered=${this.#manager.isRegistered()} revision=${this.#manager.processRevision()}`;
  }

  #dropWorkspace(): void {
    if (!this.#workspace) return;
    this.#workspace.dispose();
    liveWorkspaces().delete(this.#workspace);
    this.#workspace = undefined;
  }
}
