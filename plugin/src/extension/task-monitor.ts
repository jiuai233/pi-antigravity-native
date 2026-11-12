// Status-bar hints for live agy background tasks and artifacts. Scans the
// filesystem independently of the provider stream, polling only while an agy
// turn or a discovered task is live.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgyActivity } from "../driver/reducer.ts";
import { listAgyArtifacts } from "../native/artifacts.ts";
import { type AgyTask, listAgyTasks, stopAgyTask } from "../native/tasks.ts";
import type { AntigravityRuntime } from "../runtime/runtime.ts";

const TASKS_WIDGET_KEY = "agy-tasks";
const ARTIFACTS_WIDGET_KEY = "agy-artifacts";
const POLL_MS = 2_000;

export interface TaskSource {
  listTasks(conversationId: string, options: { sessionCwd?: string }): Promise<AgyTask[]>;
  listArtifacts(conversationId: string): Promise<readonly unknown[]>;
  stopTask(task: AgyTask, options?: { includeOrphans?: boolean }): Promise<number>;
}

const defaultTaskSource: TaskSource = {
  listTasks: listAgyTasks,
  listArtifacts: listAgyArtifacts,
  stopTask: stopAgyTask,
};

interface WidgetTheme {
  fg(color: string, text: string): string;
}

const countLine = (color: string, glyph: string, label: string, command: string) =>
  (theme: WidgetTheme): string =>
    theme.fg(color, glyph) +
    theme.fg("text", label) +
    theme.fg("dim", " • ") +
    theme.fg("accent", command) +
    theme.fg("dim", " to view");

export class TaskMonitor {
  /** Pi session cwd; task scans and the skills bridge both read it. */
  sessionCwd: string | undefined;
  readonly #runtime: Pick<AntigravityRuntime, "snapshot">;
  readonly #source: TaskSource;
  #ui: ExtensionUIContext | undefined;
  #liveCount = -1;
  #artifactCount = -1;
  #scanInFlight = false;
  #scanQueued = false;
  #agentActive = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(runtime: Pick<AntigravityRuntime, "snapshot">, source: TaskSource = defaultTaskSource) {
    this.#runtime = runtime;
    this.#source = source;
  }

  get agentActive(): boolean {
    return this.#agentActive;
  }

  attach(ui: ExtensionUIContext | undefined, cwd: string): void {
    if (ui) this.#ui = ui;
    this.sessionCwd = cwd;
    this.update();
  }

  /** Rescan task state independently from agy's provider stream. */
  readonly update = (): void => {
    if (!this.#ui) return;
    if (this.#scanInFlight) {
      this.#scanQueued = true;
      return;
    }
    this.#scanInFlight = true;
    void this.#scan();
  };

  observe(activity: AgyActivity): void {
    if (activity.type === "healed_in_turn_error") {
      this.#ui?.notify(`中途上游卡顿 ${activity.count} 次，AGY 已自动恢复`, "info");
      return;
    }
    if (
      (activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error") &&
      (activity.name === "run_command" || activity.name === "schedule")
    ) {
      // ACTIVE arrives before a sleeping command completes. Start the
      // independent filesystem scan now instead of waiting for onSettled,
      // then retry once in case the task log and holder fd are still racing.
      this.update();
      if (activity.type === "tool_start") {
        const retry = setTimeout(this.update, 500);
        retry.unref?.();
      }
    }
  }

  agentStarted(): void {
    this.#agentActive = true;
    this.update();
    this.#reconcilePolling();
  }

  agentSettled(): void {
    this.#agentActive = false;
    this.update();
  }

  /** The native conversation was discarded; its tasks no longer belong here. */
  clear(): void {
    this.#setTasks(0);
    this.#setArtifacts(0);
  }

  stopPolling(): void {
    this.#agentActive = false;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#scanQueued = false;
  }

  /** Stop tasks whose processes hold the task log open. Heuristic orphan
   *  matches stay visible in /agy-tasks and need an explicit user stop. */
  async stopLiveTasks(): Promise<void> {
    try {
      const snapshot = this.#runtime.snapshot();
      if (!snapshot.conversationId) return;
      const tasks = await this.#source.listTasks(snapshot.conversationId, {
        sessionCwd: this.sessionCwd,
      });
      const live = tasks.filter((task) => task.pids.length > 0);
      await Promise.all(live.map((task) => this.#source.stopTask(task, { includeOrphans: false })));
    } catch {
      // Runtime closed or scan failed; nothing to stop.
    }
  }

  dispose(): void {
    try {
      this.#ui?.setWidget(TASKS_WIDGET_KEY, undefined);
      this.#ui?.setWidget(ARTIFACTS_WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    this.#ui = undefined;
    this.#liveCount = -1;
    this.#artifactCount = -1;
    this.#scanInFlight = false;
  }

  async #scan(): Promise<void> {
    try {
      const snapshot = this.#runtime.snapshot();
      if (!snapshot.conversationId) {
        this.clear();
        return;
      }
      const [tasks, artifacts] = await Promise.all([
        this.#source.listTasks(snapshot.conversationId, { sessionCwd: this.sessionCwd }),
        this.#source.listArtifacts(snapshot.conversationId),
      ]);
      this.#setTasks(tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0).length);
      this.#setArtifacts(artifacts.length);
    } catch {
      // Runtime closed or scan failed; leave the widget as-is.
    } finally {
      this.#scanInFlight = false;
      if (this.#scanQueued) {
        this.#scanQueued = false;
        queueMicrotask(this.update);
      } else {
        this.#reconcilePolling();
      }
    }
  }

  #setTasks(live: number): void {
    if (!this.#ui || live === this.#liveCount) return;
    this.#liveCount = live;
    this.#render(TASKS_WIDGET_KEY, live === 0 ? undefined
      : countLine("warning", "■ ", `${live} agy background task${live === 1 ? "" : "s"}`, "/agy-tasks"));
  }

  #setArtifacts(count: number): void {
    if (!this.#ui || count === this.#artifactCount) return;
    this.#artifactCount = count;
    this.#render(ARTIFACTS_WIDGET_KEY, count === 0 ? undefined
      : countLine("success", "◆ ", `${count} agy artifact${count === 1 ? "" : "s"}`, "/agy-artifacts"));
  }

  #render(key: string, line: ((theme: WidgetTheme) => string) | undefined): void {
    const ui = this.#ui;
    if (!ui) return;
    try {
      if (!line) {
        ui.setWidget(key, undefined);
        return;
      }
      ui.setWidget(key, (_tui, theme) => {
        const text = line(theme);
        return {
          render: (width: number) => [truncateToWidth(text, width, "")],
          invalidate: () => {},
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  #reconcilePolling(): void {
    const shouldPoll = Boolean(this.#ui && (this.#agentActive || this.#liveCount > 0));
    if (shouldPoll && !this.#pollTimer) {
      this.#pollTimer = setInterval(this.update, POLL_MS);
      this.#pollTimer.unref?.();
    } else if (!shouldPoll && this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }
}
