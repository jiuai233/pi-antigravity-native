// /agy-tasks, /agy-artifacts and /agy-usage: interactive panels with
// non-interactive subcommands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findAgyArtifact, listAgyArtifacts } from "../native/artifacts.ts";
import { findAgyTask, listAgyTasks, stopAgyTask } from "../native/tasks.ts";
import { fetchAgyUsage } from "../native/usage.ts";
import type { AntigravityRuntime } from "../runtime/runtime.ts";
import { openAgyArtifactsPicker, openArtifact } from "../ui/artifacts-ui.ts";
import { openAgyTasksPicker } from "../ui/tasks-ui.ts";
import { openAgyUsagePicker } from "../ui/usage-ui.ts";
import type { TaskMonitor } from "./task-monitor.ts";

export function registerPanelCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  runtime: Pick<AntigravityRuntime, "snapshot">,
  monitor: Pick<TaskMonitor, "update">,
): void {
  pi.registerCommand("agy-tasks", {
    description: "List agy background tasks; `stop <task-id>|stop all` to terminate",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const conversationId = runtime.snapshot().conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-tasks: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyTasks(conversationId, { sessionCwd: ctx.cwd });

      // No arguments: interactive dashboard overlay (x stops, r rescans).
      if (!arg) {
        await openAgyTasksPicker(ctx, rescan);
        monitor.update();
        return;
      }

      const tasks = await rescan();
      const stopMatch = arg.match(/^stop\s+(.+)$/);
      if (!stopMatch) {
        ctx.ui.notify('agy-tasks: usage "/agy-tasks" or "/agy-tasks stop <task-id>|all".', "error");
        return;
      }
      const target = stopMatch[1].trim();
      const selected =
        target === "all"
          ? tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0)
          : [findAgyTask(tasks, target)].filter(
              (task): task is NonNullable<typeof task> => task !== undefined,
            );
      if (selected.length === 0) {
        ctx.ui.notify(`agy-tasks: no running task "${target}" in this conversation.`, "error");
        return;
      }
      const results = await Promise.all(selected.map((task) => stopAgyTask(task)));
      const stopped = selected.map((task) => task.id).join(", ");
      ctx.ui.notify(
        `agy-tasks: sent SIGTERM to ${stopped} (${results.reduce((sum, count) => sum + count, 0)} process(es)).`,
        "info",
      );
      monitor.update();
    },
  });

  pi.registerCommand("agy-artifacts", {
    description: "List the agy conversation's artifacts (agent-created files, uploads)",
    handler: async (args, ctx) => {
      const conversationId = runtime.snapshot().conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-artifacts: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyArtifacts(conversationId);
      const arg = args.trim();

      // `open <name>`: non-interactive open by exact name or unique prefix.
      const openMatch = arg.match(/^open\s+(.+)$/);
      if (openMatch) {
        const artifacts = await rescan();
        const artifact = findAgyArtifact(artifacts, openMatch[1]);
        if (!artifact) {
          ctx.ui.notify(`agy-artifacts: no artifact matching "${openMatch[1]}".`, "error");
          return;
        }
        try {
          await openArtifact(artifact.absolutePath);
          ctx.ui.notify(`agy-artifacts: opened ${artifact.name}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `agy-artifacts: failed to open ${artifact.name} (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }
      if (arg) {
        ctx.ui.notify(
          'agy-artifacts: usage "/agy-artifacts" or "/agy-artifacts open <name>".',
          "error",
        );
        return;
      }

      await openAgyArtifactsPicker(ctx, rescan);
    },
  });

  pi.registerCommand("agy-usage", {
    description: "Show Antigravity model quotas (weekly and 5-hour limits)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-usage: usage "/agy-usage".', "error");
        return;
      }
      await openAgyUsagePicker(ctx, (signal) => fetchAgyUsage({ signal }));
    },
  });
}
