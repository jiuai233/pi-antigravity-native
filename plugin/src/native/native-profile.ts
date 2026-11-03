import { createHash } from "node:crypto";
import fs from "node:fs";

export interface NativeProfile {
  id: string;
  /** Tools agy runs natively; the default profile inherits the surface list. */
  native_tools: string[];
  /** When set, only these Pi tools are bridged (closed dossier). */
  bridge_tool_allowlist?: string[];
  schema_delivery?: string;
  native_skill_reader?: string | null;
}

interface ExecutionSurface {
  native_tools: string[];
  profiles: { default: NativeProfile; evidence_only_v1: NativeProfile };
  [key: string]: unknown;
}

interface TaskEnvelope {
  package_id?: string;
  agent?: { role?: string };
  extensions?: { review_execution?: { profile?: string } };
}

export const executionSurface = JSON.parse(
  fs.readFileSync(new URL("../../execution-surface.json", import.meta.url), "utf8"),
) as ExecutionSurface;
export const DEFAULT_NATIVE_TOOLS = executionSurface.native_tools;
executionSurface.profiles.default.native_tools = DEFAULT_NATIVE_TOOLS;

/** Only the runner's explicit local worker envelope can select a closed dossier. */
export function readNativeProfile(env: NodeJS.ProcessEnv = process.env): NativeProfile {
  const file = env.PI_WORKER_TASK_PACKAGE_PATH?.trim();
  if (!file || !env.SUBAGENT_PROJECT_ROOT?.trim()) return executionSurface.profiles.default;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TaskEnvelope & { task_package?: TaskEnvelope };
  const task = parsed.task_package ?? parsed;
  if (!task.package_id || !task.agent?.role) return executionSurface.profiles.default;
  return task.extensions?.review_execution?.profile === "evidence_only_v1"
    ? executionSurface.profiles.evidence_only_v1 : executionSurface.profiles.default;
}

export function nativeBridgedTools<T extends { name: string }>(tools: T[], profile: NativeProfile): T[] {
  const allowlist = profile.bridge_tool_allowlist;
  return allowlist ? tools.filter((tool) => allowlist.includes(tool.name)) : tools;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

/** Excludes instance-owned paths/server names so a restored equal contract can resume. */
export function nativeContractHash(
  profile: NativeProfile,
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    profile: profile.id, native_tools: profile.native_tools,
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))).digest("hex");
}
