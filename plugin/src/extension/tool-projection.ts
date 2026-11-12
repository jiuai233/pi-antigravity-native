// Projects the Pi tools of one SDK request onto the native agent: the same
// snapshot feeds the agent file and the MCP catalog, plus one activate_skill
// tool for global Pi skills.

import { nativeBridgedTools, nativeContractHash, readNativeProfile } from "../native/native-profile.ts";
import type { NativeWorkspaceRegistration } from "../native/native-workspace.ts";
import { type AgyPiBridge, type BridgeToolDef, type PiToolInfo, canonicalToolDefinitions, selectBridgedTools } from "./bridge.ts";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  activateSkillDescription,
  activateSkillParameters,
  handleActivateSkill,
  type SkillLite,
} from "./skills.ts";

type NativeProfile = ReturnType<typeof readNativeProfile>;

export interface ToolProjectionDeps {
  bridge: AgyPiBridge;
  /** Global Pi skills to publish through activate_skill. */
  skills: () => SkillLite[];
  readProfile?: () => NativeProfile;
}

export class ToolProjection {
  #snapshot: BridgeToolDef[] = [];
  readonly #bridge: AgyPiBridge;
  readonly #skills: () => SkillLite[];
  readonly #readProfile: () => NativeProfile;

  constructor({ bridge, skills, readProfile = readNativeProfile }: ToolProjectionDeps) {
    this.#bridge = bridge;
    this.#skills = skills;
    this.#readProfile = readProfile;
    // MCP refreshes read the request's snapshot; they never recompute it.
    bridge.setToolSource(() => this.#snapshot);
  }

  get snapshot(): BridgeToolDef[] {
    return this.#snapshot;
  }

  /** Publish one activate_skill tool for global Pi skills. */
  refreshSkillTools(profile: NativeProfile = this.#readProfile()): void {
    this.#bridge.setReadable(profile.native_tools.includes("view_file"));
    const skills = this.#skills();
    if (skills.length === 0 || profile.id === "evidence_only_v1") {
      this.#bridge.setDynamicTools([]);
      return;
    }
    this.#bridge.setDynamicTools([
      {
        name: ACTIVATE_SKILL_TOOL_NAME,
        description: activateSkillDescription(skills),
        parameters: activateSkillParameters(skills),
        handler: (args) => handleActivateSkill(skills, args),
      },
    ]);
  }

  /** Replace the snapshot from this request's declared tools and rewrite the agent. */
  prepare(workspace: NativeWorkspaceRegistration, systemPrompt: string, declaredTools: readonly PiToolInfo[]) {
    const profile = this.#readProfile();
    this.#snapshot = canonicalToolDefinitions(nativeBridgedTools(
      selectBridgedTools([...declaredTools], declaredTools.map((tool) => tool.name)), profile,
    ));
    this.refreshSkillTools(profile);
    workspace.writeSystemPrompt(systemPrompt, this.#snapshot, profile);
    return {
      name: workspace.agentName,
      nativeTools: profile.native_tools,
      nativeContractHash: nativeContractHash(profile, this.#snapshot),
      agentBody: workspace.agentBody,
    };
  }
}
