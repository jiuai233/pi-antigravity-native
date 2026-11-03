// The display-only `antigravity` tool. agy already ran the native step; the
// provider records its result and this tool replays it into Pi's transcript.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WRAPPER_TOOL_DESCRIPTION, WRAPPER_TOOL_NAME } from "../input/prompt.ts";
import type { AgyReplayStore, RecordedAgyTool } from "../provider/replay.ts";
import { agyToolLabel, formatAgyCall, summarizeAgyResult } from "../ui/render.ts";

export function registerWrapperTool(pi: Pick<ExtensionAPI, "registerTool">, replay: AgyReplayStore): void {
  pi.registerTool({
    name: WRAPPER_TOOL_NAME,
    label: "antigravity",
    description: WRAPPER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      tool: Type.String(),
      input: Type.Unknown(),
    }),
    async execute(toolCallId, params) {
      const recorded = replay.take(toolCallId);
      if (!recorded) {
        throw new Error(`No recorded antigravity result for "${params.tool}".`);
      }
      if (recorded.error) {
        throw new Error(recorded.error);
      }
      const body = recorded.output || "(no output)";
      const text = recorded.agyTool === "view_file" ? body : body.slice(0, 16_000);
      return {
        content: recorded.content ?? [{ type: "text", text }],
        details: recorded,
      };
    },
    renderCall(args, theme) {
      return new Text(formatAgyCall(args.tool, args.input, theme), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const body = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as RecordedAgyTool | undefined;
      const tool = details?.agyTool ?? "tool";
      if (context.isError) {
        const message = body && body !== "(no output)" ? body.split("\n")[0] : "failed";
        return new Text(theme.fg("error", `✗ ${agyToolLabel(tool)}: ${message}`), 0, 0);
      }
      const secs =
        typeof details?.durationSeconds === "number"
          ? theme.fg("muted", ` (${details.durationSeconds.toFixed(2)}s)`)
          : "";
      const { counts } = summarizeAgyResult(tool, details?.output);
      const parts = [theme.fg("success", "✓ "), counts ? theme.fg("muted", counts) : "", secs];
      let text = parts.join("");
      if (body && body !== "(no output)") {
        const lines = body.split("\n");
        const shown = expanded ? lines : lines.slice(0, 3);
        text += `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
        if (!expanded && lines.length > 3) {
          text += theme.fg("muted", `\n… +${lines.length - 3} lines (ctrl+o to expand)`);
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
