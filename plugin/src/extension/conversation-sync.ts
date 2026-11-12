// Keeps Pi's session log and the native agy conversation in step: which native
// conversation a reload may resume, when it must restart, and when agy
// compacted on its own.

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgyActivity } from "../driver/reducer.ts";
import {
  AGY_COMPACTION_ENTRY,
  type AgyCompactionMarker,
  agyContextTokens,
  detectAgyCompaction,
  formatAgyContextTokens,
} from "../native/agy-compaction.ts";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  type PersistedAgyConversation,
  type PersistedAgyReset,
  restorableAgyConversation,
} from "../native/conversation-state.ts";
import type { AntigravityRuntime } from "../runtime/runtime.ts";

type AppendEntry = (customType: string, data: unknown) => void;
type SyncRuntime = Pick<AntigravityRuntime, "snapshot" | "setSession">;

export interface SessionFields {
  provider: string | undefined;
  sessionId: string;
  cwd: string;
  branch?: readonly SessionEntry[];
}

export const isStaleContextError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("extension ctx is stale");

/** Read session-bound fields before awaiting: Pi may replace the session meanwhile. */
export function sessionFields(ctx: ExtensionContext): SessionFields | undefined {
  try {
    const branch = typeof ctx.sessionManager.getBranch === "function"
      ? ctx.sessionManager.getBranch()
      : undefined;
    return { provider: ctx.model?.provider, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, branch };
  } catch (error) {
    if (isStaleContextError(error)) return undefined;
    throw error;
  }
}

export const conversationStateKey = (state: {
  conversationId: string;
  modelId: string;
  turns: number;
  systemPromptHash?: string;
  nativeContractHash?: string;
}): string => `${state.conversationId}:${state.modelId}:${state.turns}:${state.systemPromptHash ?? ""}:${state.nativeContractHash ?? ""}`;

export function registerCompactionRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
  pi.registerEntryRenderer(AGY_COMPACTION_ENTRY, (entry, _options, theme) => {
    const marker = entry.data as AgyCompactionMarker;
    const text =
      theme.fg("dim", "── ") +
      theme.fg("accent", "agy compacted context") +
      theme.fg(
        "dim",
        ` · ~${formatAgyContextTokens(marker.beforeTokens)} → ~${formatAgyContextTokens(marker.afterTokens)} ──`,
      );
    return {
      render: (width: number) => [truncateToWidth(text, width, "")],
      invalidate: () => {},
    };
  });
}

export class ConversationSync {
  /** Last observed native context size; a large drop means agy compacted. */
  contextTokens: number | undefined;
  /** Key of the last persisted conversation entry, so repeats are skipped. */
  persistedKey: string | undefined;
  readonly #runtime: SyncRuntime;
  readonly #append: AppendEntry;

  constructor(runtime: SyncRuntime, append: AppendEntry) {
    this.#runtime = runtime;
    this.#append = append;
  }

  /** Record the native conversation a reload may resume. */
  async persist(ctx: ExtensionContext): Promise<void> {
    const session = sessionFields(ctx);
    if (session?.provider !== "antigravity") return;
    const snapshot = this.#runtime.snapshot();
    if (!snapshot.conversationId || !snapshot.model || snapshot.cwd !== session.cwd) return;
    const state: PersistedAgyConversation = {
      version: 1,
      kind: "conversation",
      sessionId: session.sessionId,
      conversationId: snapshot.conversationId,
      cwd: session.cwd,
      modelId: snapshot.model,
      turns: snapshot.turns,
      usage: snapshot.conversationUsage,
      contextTokens: this.contextTokens,
      systemPromptHash: snapshot.systemPromptHash,
      nativeContractHash: snapshot.nativeContractHash,
    };
    const key = conversationStateKey(state);
    const anchored =
      !session.branch ||
      restorableAgyConversation(session.branch, session.sessionId, session.cwd)?.conversationId ===
        state.conversationId;
    if (key === this.persistedKey && anchored) return;
    if (this.#appendState(state)) this.persistedKey = key;
  }

  /** Mark the native conversation discarded so a reload cannot resurrect it. */
  appendReset(session: { sessionId: string; cwd: string }): void {
    this.#appendState({ version: 1, kind: "reset", sessionId: session.sessionId, cwd: session.cwd });
    this.forget();
  }

  /** agy cannot rewind or shrink a native conversation to match Pi's branch.
   *  Restart it; the next provider call bootstraps the current Pi branch.
   *  False when the session was already replaced: its session_start owns the runtime. */
  async restartNative(ctx: ExtensionContext): Promise<boolean> {
    const session = sessionFields(ctx);
    if (!session) return false;
    await this.#runtime.setSession(session.cwd, undefined, true);
    this.appendReset(session);
    return true;
  }

  /** Continue a restored conversation's context tracking and persisted state. */
  adopt(restored: PersistedAgyConversation): void {
    this.contextTokens = restored.contextTokens;
    this.persistedKey = conversationStateKey(restored);
  }

  forget(): void {
    this.contextTokens = undefined;
    this.persistedKey = undefined;
  }

  observe(activity: AgyActivity): void {
    if (activity.type === "conversation_fallback") {
      this.forget();
      return;
    }
    if (activity.type !== "usage") return;
    const nextContextTokens = agyContextTokens(activity.usage);
    const compaction = detectAgyCompaction(this.contextTokens, nextContextTokens);
    if (compaction) {
      const marker: AgyCompactionMarker = {
        version: 1,
        ...compaction,
        detectedAt: new Date().toISOString(),
      };
      this.#append(AGY_COMPACTION_ENTRY, marker);
    }
    this.contextTokens = nextContextTokens;
  }

  /** False when the session was replaced mid-write; other failures propagate. */
  #appendState(state: PersistedAgyConversation | PersistedAgyReset): boolean {
    try {
      this.#append(AGY_CONVERSATION_STATE_ENTRY, state);
      return true;
    } catch (error) {
      if (isStaleContextError(error)) return false;
      throw error;
    }
  }
}
