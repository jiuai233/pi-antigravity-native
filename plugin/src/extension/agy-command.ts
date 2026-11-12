// /agy: native conversation status, reset, model re-discovery, custom agents
// and the doctor report.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { checkAgyBinary, MIN_AGY_VERSION } from "../driver/agy-diagnostics.ts";
import { parseAgyAgents, readAgyProcessProfile } from "../driver/agy-profile.ts";
import { formatAgyContextTokens } from "../native/agy-compaction.ts";
import { readAgyConversationMetadata } from "../native/conversation-metadata.ts";
import { agyConversationExists } from "../native/conversation-state.ts";
import type { AgyPrefixAudit } from "../native/prefix-audit.ts";
import { mapThinkingToEffort } from "../provider/mapping.ts";
import { capabilitiesForModel, resolveAgyModelEffort } from "../provider/models.ts";
import type { AntigravityRuntime, AntigravityStateSnapshot } from "../runtime/runtime.ts";
import type { BridgeHost } from "./bridge-host.ts";
import { type ConversationSync, sessionFields } from "./conversation-sync.ts";
import { execAgy, type ModelCache, type ModelCatalog, modelDiscoveryFailure } from "./model-catalog.ts";

export interface AgyCommandDeps {
  runtime: AntigravityRuntime;
  sync: ConversationSync;
  catalog: ModelCatalog;
  bridge: BridgeHost;
  audit?: AgyPrefixAudit;
  /** Re-run model discovery and re-register the provider. */
  refreshModels(): Promise<ModelCache>;
}

type BinaryCheck = Awaited<ReturnType<typeof checkAgyBinary>>;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function statusOneLine(value: string, maxLength = 160): string {
  return stripTerminalSequences(value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: status text must not carry control characters.
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function registerAgyCommand(pi: Pick<ExtensionAPI, "registerCommand">, deps: AgyCommandDeps): void {
  pi.registerCommand("agy", {
    description: "Manage the agy backend: status | reset | models | agents | doctor",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "reset") return resetConversation(ctx, deps);
      if (sub === "models") return refreshModelList(ctx, deps);
      if (sub === "agents") return listAgents(ctx);
      if (sub === "doctor") return doctor(ctx, deps);
      if (sub) {
        ctx.ui.notify(
          `antigravity: unknown argument "${sub}". Use reset | models | agents | doctor.`,
          "error",
        );
        return;
      }
      return showStatus(ctx, deps);
    },
  });
}

async function resetConversation(ctx: ExtensionCommandContext, { runtime, sync }: AgyCommandDeps): Promise<void> {
  const session = sessionFields(ctx);
  await runtime.reset();
  if (session) sync.appendReset(session);
  ctx.ui.notify("antigravity: conversation reset; next turn starts fresh.", "info");
}

async function refreshModelList(ctx: ExtensionCommandContext, deps: AgyCommandDeps): Promise<void> {
  const refreshed = await deps.refreshModels();
  ctx.ui.notify(
    refreshed.discoveryError !== undefined
      ? modelDiscoveryFailure(refreshed)
      : `antigravity: ${refreshed.models.length} models registered (${refreshed.source}).`,
    refreshed.discoveryError !== undefined ? "warning" : "info",
  );
}

async function listAgents(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const agents = parseAgyAgents(await execAgy(["agents"]));
    ctx.ui.notify(
      agents.length > 0
        ? `antigravity custom agents:\n${agents.map((agent) => `• ${agent}`).join("\n")}`
        : "antigravity: no custom agents configured.",
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`antigravity: failed to list agents (${errorText(error)}).`, "error");
  }
}

async function doctor(ctx: ExtensionCommandContext, deps: AgyCommandDeps): Promise<void> {
  const lines = ["antigravity doctor"];
  const binary = await checkAgyBinary({ refresh: true });
  appendBinary(lines, binary);

  const cache = await deps.refreshModels();
  lines.push(cache.discoveryError !== undefined
    ? modelDiscoveryFailure(cache)
    : `models: ${cache.models.length} (live)`);

  let snapshot: AntigravityStateSnapshot | undefined;
  try {
    snapshot = deps.runtime.snapshot();
    appendDriver(lines, snapshot);
  } catch (error) {
    lines.push(`driver: ERROR ${errorText(error)}`);
  }

  appendSelection(lines, ctx, deps.catalog);
  lines.push(`bridge: ${deps.bridge.describe()}`);
  await appendConversation(lines, snapshot?.conversationId);
  if (deps.audit) lines.push(...deps.audit.details());
  ctx.ui.notify(
    lines.join("\n"),
    binary.ok && deps.catalog.cache.discoveryError === undefined ? "info" : "error",
  );
}

function appendBinary(lines: string[], binary: BinaryCheck): void {
  if (binary.ok) {
    lines.push(
      `binary: ${binary.binary} (${binary.version}, ${binary.source})`,
      `binary selection: ${binary.selectionReason ?? "compatible candidate"}`,
      `minimum: ${MIN_AGY_VERSION}`,
    );
  } else {
    lines.push(
      `binary: ERROR [${binary.category}] ${binary.message}`,
      `minimum: ${MIN_AGY_VERSION}`,
    );
  }
  for (const candidate of binary.candidates ?? []) {
    const selected =
      binary.ok && candidate.binary === binary.binary ? "selected" : "candidate";
    lines.push(
      `binary ${selected}: ${candidate.source} ${candidate.binary} · ${
        candidate.ok
          ? candidate.development
            ? (candidate.version ?? "development")
            : (candidate.version ?? "unknown")
          : `ERROR [${candidate.category ?? "unknown"}]`
      }`,
    );
  }
}

function appendDriver(lines: string[], snapshot: AntigravityStateSnapshot): void {
  const executor = snapshot.executor;
  const config = executor.config;
  lines.push(
    `driver: ${executor.mode} · ${executor.state}${executor.pid ? ` · pid ${executor.pid}` : ""}`,
    `driver binary: ${config?.binary ?? "none"}${config?.binaryVersion ? ` · ${config.binaryVersion}` : ""}`,
    `driver config: model=${config?.model ?? "none"} effort=${config?.effort ?? "none"} agent=${config?.agent ?? "none"} mode=${config?.mode ?? "default"}`,
  );
  if (executor.stats) {
    const stats = executor.stats;
    const reasons = Object.entries(stats.recycleReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    lines.push(
      executor.mode === "persistent"
        ? `driver stats: spawns=${stats.spawnCount} respawns=${Math.max(0, stats.spawnCount - 1)} turns=${stats.submittedTurns} reused=${stats.reusedTurns} recycles=${stats.recycleCount} current=${stats.currentProcessTurns}`
        : `driver stats: one-shot launches=${stats.spawnCount} turns=${stats.submittedTurns}`,
      `driver recycle reasons: ${reasons || "none"}`,
    );
  }
}

function appendSelection(lines: string[], ctx: ExtensionCommandContext, catalog: ModelCatalog): void {
  const selected = catalog.find(ctx.model?.id);
  let profile = "agent=none mode=default";
  try {
    const configured = readAgyProcessProfile();
    profile = `agent=${configured.agent ?? "none"} mode=${configured.mode ?? "default"}`;
    lines.push(
      `selection: ${ctx.model?.id ?? "none"} · effort ${
        resolveAgyModelEffort(
          selected,
          ctx.thinkingLevel === "off"
            ? undefined
            : mapThinkingToEffort(
                ctx.thinkingLevel as Exclude<typeof ctx.thinkingLevel, "off">,
              ),
        ) ?? "none"
      }`,
    );
  } catch (error) {
    lines.push(`profile: ERROR ${errorText(error)}`);
  }
  lines.push(`profile: ${profile}`);
}

async function appendConversation(lines: string[], conversationId: string | undefined): Promise<void> {
  if (!conversationId) {
    lines.push("conversation: none", "metadata: not applicable");
    return;
  }
  const [exists, metadata] = await Promise.all([
    agyConversationExists(conversationId),
    readAgyConversationMetadata(conversationId),
  ]);
  lines.push(
    `conversation: ${conversationId} · db ${exists ? "readable" : "missing/unreadable"}`,
    `metadata: ${metadata.status}`,
  );
}

async function showStatus(ctx: ExtensionCommandContext, { runtime, sync, audit }: AgyCommandDeps): Promise<void> {
  const snapshot = runtime.snapshot();
  const id = snapshot.conversationId;
  const metadata = id ? await readAgyConversationMetadata(id) : undefined;
  const metadataTitle = metadata?.metadata?.title
    ? statusOneLine(metadata.metadata.title)
    : undefined;
  const title = metadataTitle || (id ? id.slice(0, 12) : "none — next turn starts fresh");
  const updated = metadata?.metadata?.updatedAt
    ? new Date(metadata.metadata.updatedAt).toLocaleString()
    : undefined;
  const contextTokens = sync.contextTokens;
  const details = [
    `model: ${snapshot.model ?? "unselected"}`,
    `turns: ${snapshot.turns}`,
    `driver: ${snapshot.executor.mode}/${snapshot.executor.state}${snapshot.executor.pid ? ` pid=${snapshot.executor.pid}` : ""}`,
    contextTokens === undefined
      ? undefined
      : `native context: ~${formatAgyContextTokens(contextTokens)}/${formatAgyContextTokens(capabilitiesForModel(snapshot.model ?? "").contextWindow)} configured`,
    metadata?.metadata?.numSteps === undefined
      ? undefined
      : `native steps: ${metadata.metadata.numSteps}`,
    updated ? `updated: ${updated}` : undefined,
  ].filter((part): part is string => part !== undefined);
  let profile = "agent: none · mode: default";
  try {
    const configured = readAgyProcessProfile();
    profile = `agent: ${configured.agent ?? "none"} · mode: ${configured.mode ?? "default"}`;
  } catch (error) {
    profile = `profile error: ${errorText(error)}`;
  }
  ctx.ui.notify(
    `antigravity: ${title}\nconversation: ${id ?? "none"}\n${details.join(" · ")}\n${profile}${audit ? `\n${audit.details().join("\n")}` : ""}`,
    "info",
  );
}
