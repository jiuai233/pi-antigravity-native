import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import type { BridgeContent } from "../extension/bridge.ts";
import { DEFAULT_NATIVE_TOOLS } from "./native-profile.ts";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

const CHECKPOINT_256K = Buffer.from([0x28, 0x80, 0xd0, 0x0f]);
const CHECKPOINT_512K = Buffer.from([0x28, 0x80, 0xa0, 0x1f]);

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let val = 0;
  let shift = 0;
  let cursor = pos;
  while (cursor < buf.length) {
    const b = buf[cursor++];
    val += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [val, cursor];
    shift += 7;
  }
  throw new Error("Truncated protobuf varint.");
}

function skipVarint(buf: Uint8Array, pos: number): number {
  let cursor = pos;
  while (cursor < buf.length) {
    if ((buf[cursor++] & 0x80) === 0) return cursor;
  }
  throw new Error("Truncated protobuf varint.");
}

function patchProtobufPath(
  buf: Buffer,
  pathFields: readonly number[],
  mutator: (content: Buffer) => Buffer,
): Buffer {
  if (pathFields.length === 0) return mutator(buf);
  const targetField = pathFields[0];
  const chunks: Buffer[] = [];
  let pos = 0;
  let changed = false;
  while (pos < buf.length) {
    const tagStart = pos;
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      pos = skipVarint(buf, pos);
      chunks.push(buf.subarray(tagStart, pos));
    } else if (wire === 1) {
      pos += 8;
      chunks.push(buf.subarray(tagStart, pos));
    } else if (wire === 5) {
      pos += 4;
      chunks.push(buf.subarray(tagStart, pos));
    } else if (wire === 2) {
      const [len, contentStart] = readVarint(buf, pos);
      const contentEnd = contentStart + len;
      const original = buf.subarray(contentStart, contentEnd);
      if (field === targetField) {
        const updated = patchProtobufPath(original, pathFields.slice(1), mutator);
        if (!updated.equals(original)) {
          changed = true;
          chunks.push(buf.subarray(tagStart, afterTag), encodeVarint(updated.length), updated);
        } else {
          chunks.push(buf.subarray(tagStart, contentEnd));
        }
      } else {
        chunks.push(buf.subarray(tagStart, contentEnd));
      }
      pos = contentEnd;
    } else {
      return buf;
    }
  }
  return changed ? Buffer.concat(chunks) : buf;
}

/** Preserve unrelated spec fields/MCP filters; native membership is the whitelist.
 * ToolFilter field 2 is builtin, NOT enabled: false requires a provider_name.
 */
function applyNativeToolFilters(spec: Buffer, nativeTools: readonly string[]): Buffer {
  const reader = new BinaryReader(spec);
  const chunks: Buffer[] = [];
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const [field, wire] = reader.tag();
    if (field === 3 && wire === WireType.LengthDelimited) {
      const filter = reader.bytes();
      const name = byteFields(filter, 1)[0];
      if (name && DEFAULT_NATIVE_TOOLS.includes(Buffer.from(name).toString("utf8"))) continue;
    } else reader.skip(wire, field);
    chunks.push(spec.subarray(start, reader.pos));
  }
  for (const name of DEFAULT_NATIVE_TOOLS.filter(name => nativeTools.includes(name))) {
    const text = Buffer.from(name);
    const filter = Buffer.concat([Buffer.from([0x0a]), encodeVarint(text.length), text,
      Buffer.from([0x10, 0x01])]);
    chunks.push(Buffer.from([0x1a]), encodeVarint(filter.length), filter);
  }
  return Buffer.concat(chunks);
}

export interface AgentPromptSection {
  title: string;
  content: string;
}

function stripYamlFrontmatter(markdown: string): string {
  const frontmatter = /^---(?:\r\n|\r|\n)[\s\S]*?^---(?:\r\n|\r|\n)/m.exec(markdown);
  return frontmatter?.index === 0 ? markdown.slice(frontmatter[0].length) : markdown;
}

/**
 * Split custom-agent Markdown into the exact PromptSection records agy stores
 * in AgentConfig.field_2: initial title "System Prompt" before the first H1,
 * top-level `# Heading` boundaries outside fenced code blocks, trimmed bodies,
 * empty sections omitted.
 */
export function parseAgentPromptSections(markdown: string): AgentPromptSection[] {
  const source = stripYamlFrontmatter(markdown);
  const sections: AgentPromptSection[] = [];
  let title = "System Prompt";
  let lines: string[] = [];
  let fenceChar: "`" | "~" | undefined;
  let fenceLen = 0;

  const flush = () => {
    const content = lines.join("").trim();
    if (content) sections.push({ title, content });
    lines = [];
  };

  // Inspect line text for Markdown structure, but retain the original prompt bytes.
  for (const rawLine of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    const line = rawLine.replace(/(?:\r\n|\r|\n)$/, "");
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const ch = marker[0] as "`" | "~";
      const rest = fenceMatch[2];
      if (!fenceChar) {
        if (ch === "~" || !rest.includes("`")) {
          fenceChar = ch;
          fenceLen = marker.length;
        }
      } else if (ch === fenceChar && marker.length >= fenceLen && /^\s*$/.test(rest)) {
        fenceChar = undefined;
        fenceLen = 0;
      }
      lines.push(rawLine);
      continue;
    }
    if (!fenceChar) {
      const heading = line.match(/^#\s+(.+?)\s*$/);
      if (heading) {
        flush();
        title = heading[1];
        continue;
      }
    }
    lines.push(rawLine);
  }
  flush();
  return sections;
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodePromptSectionEntry(title: string, content: string): Buffer {
  const parts: Buffer[] = [];
  if (title.length > 0) parts.push(encodeLengthDelimited(1, Buffer.from(title, "utf8")));
  if (content.length > 0) parts.push(encodeLengthDelimited(2, Buffer.from(content, "utf8")));
  const section = Buffer.concat(parts);
  const wrapper = encodeLengthDelimited(1, section);
  return encodeLengthDelimited(2, wrapper);
}

/** Replace AgentConfig.field_2 PromptSection wrappers while preserving all other fields. */
export function applyAgentPromptSections(
  spec: Buffer,
  sections: readonly AgentPromptSection[],
): Buffer {
  if (sections.length === 0) return spec;
  const reader = new BinaryReader(spec);
  const before: Buffer[] = [];
  const after: Buffer[] = [];
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const [field, wire] = reader.tag();
    reader.skip(wire, field);
    if (field === 2 && wire === WireType.LengthDelimited) continue;
    (field < 2 ? before : after).push(spec.subarray(start, reader.pos));
  }
  const encoded = sections.map(({ title, content }) => encodePromptSectionEntry(title, content));
  return Buffer.concat([...before, ...encoded, ...after]);
}

function upgradeCheckpoint512k(ckpt: Buffer): Buffer {
  const idx = ckpt.indexOf(CHECKPOINT_256K);
  if (idx === -1) return ckpt;
  return Buffer.concat([
    ckpt.subarray(0, idx),
    CHECKPOINT_512K,
    ckpt.subarray(idx + CHECKPOINT_256K.length),
  ]);
}

export interface NativeToolResult {
  args: Record<string, string>;
  output: string;
  media?: { mimeType: string; path?: string; data?: string }[];
  content?: BridgeContent[];
}

function byteFields(bytes: Uint8Array, field: number): Uint8Array[] {
  const reader = new BinaryReader(bytes);
  const values: Uint8Array[] = [];
  while (reader.pos < reader.len) {
    const [number, wire] = reader.tag();
    if (number === field && wire === WireType.LengthDelimited) values.push(reader.bytes());
    else reader.skip(wire, number);
  }
  return values;
}

/** CLI 1.4.4 Cortex tool payload: ToolInfo=140, parameters=1, output=2/text=1. */
export function decodeNativeToolResult(payload: Uint8Array): NativeToolResult {
  const tool = byteFields(payload, 140)[0];
  if (!tool) throw new Error("Native step has no tool record.");
  const args: Record<string, string> = {};
  for (const entry of byteFields(tool, 1)) {
    const key = Buffer.from(byteFields(entry, 1)[0]).toString("utf8");
    if (key === "toolAction" || key === "toolSummary") continue;
    args[key] = Buffer.from(byteFields(entry, 2)[0]).toString("utf8");
  }
  const output = byteFields(tool, 2)[0];
  if (!output) throw new Error("Native step has no stored output.");
  const text = byteFields(output, 1)[0];
  if (!text) throw new Error("Native step has no stored text output.");
  const media = byteFields(output, 4).map(part => {
    const mimeType = Buffer.from(byteFields(part, 1)[0]).toString("utf8");
    const uri = byteFields(part, 5)[0];
    const data = byteFields(part, 2)[0];
    return { mimeType,
      ...(uri?.length ? { path: Buffer.from(uri).toString("utf8") } : {}),
      ...(data?.length ? { data: Buffer.from(data).toString("base64") } : {}),
    };
  });
  return { args, output: Buffer.from(text).toString("utf8"),
    ...(media.length ? { media } : {}),
  };
}

/** Read the already-executed native step; never reopens the viewed source file. */
export function readNativeToolResult(conversationId: string, stepId: number, cwd: string): NativeToolResult {
  const file = path.join(resolveAgyDataDirectory(cwd), "conversations", `${conversationId}.db`);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT step_payload FROM steps WHERE idx = ?").get(stepId);
    if (!(row?.step_payload instanceof Uint8Array)) throw new Error(`Native step ${stepId} is not persisted.`);
    const result = decodeNativeToolResult(row.step_payload);
    if (result.media?.length) {
      result.content = [{ type: "text", text: result.output }];
      for (const media of result.media) {
        if (media.mimeType.startsWith("image/")) {
          let data = media.data;
          if (!data) {
            if (!media.path) throw new Error("Native image has no saved attachment or inline bytes.");
            const file = media.path.startsWith("file:") ? fileURLToPath(media.path) : path.resolve(cwd, media.path);
            data = fs.readFileSync(file).toString("base64");
          }
          result.content.push({ type: "image", data, mimeType: media.mimeType });
        } else {
          result.content.push({ type: "text", text: `Native media (${media.mimeType}): ${media.path ?? "stored in native tool record"}` });
        }
      }
    }
    return result;
  } finally {
    database.close();
  }
}

export type NativeConversationUpgradeResult =
  | { status: "unchanged" | "migrated" }
  | { status: "failed"; message: string };

/**
 * Align persisted CustomAgentSpec PromptSections + native ToolFilters with the
 * active agent snapshot and upgrade 256K->512K checkpoints before spawning
 * `agy --conversation <id>`.
 */
export function upgradeNativeConversationDb(
  conversationId: string,
  cwd = process.cwd(),
  nativeTools: readonly string[] = DEFAULT_NATIVE_TOOLS,
  agentBody?: string,
): NativeConversationUpgradeResult {
  let specVisited = 0;
  const sections = agentBody?.trim() ? parseAgentPromptSections(agentBody) : undefined;
  const alignFilters = (spec: Buffer) => {
    specVisited += 1;
    const withTools = applyNativeToolFilters(spec, nativeTools);
    return sections?.length ? applyAgentPromptSections(withTools, sections) : withTools;
  };
  const file = path.join(resolveAgyDataDirectory(cwd), "conversations", `${conversationId}.db`);
  let database: DatabaseSync | undefined;
  let transactionStarted = false;
  try {
    if (!fs.existsSync(file)) return { status: "unchanged" };
    database = new DatabaseSync(file);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    let modified = false;
    const execRows = database.prepare("SELECT idx, data FROM executor_metadata").all() as Array<{
      idx: number;
      data: Uint8Array;
    }>;
    const updateExec = database.prepare("UPDATE executor_metadata SET data = ? WHERE idx = ?");
    for (const row of execRows) {
      if (!(row.data instanceof Uint8Array)) continue;
      const buf = Buffer.from(row.data);
      const step1 = patchProtobufPath(buf, [10, 1, 46], alignFilters);
      const step2 = patchProtobufPath(step1, [10, 2], upgradeCheckpoint512k);
      if (!step2.equals(buf)) {
        updateExec.run(step2, row.idx);
        modified = true;
      }
    }

    const blobRow = database
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = ?")
      .get("main") as { data?: Uint8Array } | undefined;
    if (blobRow?.data instanceof Uint8Array) {
      const buf = Buffer.from(blobRow.data);
      const step1 = patchProtobufPath(buf, [4, 7, 18, 1], alignFilters);
      const step2 = patchProtobufPath(step1, [10, 18, 1], alignFilters);
      if (!step2.equals(buf)) {
        database.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?").run(step2, "main");
        modified = true;
      }
    }

    const genRows = database
      .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx")
      .all() as Array<{ idx: number; data: Uint8Array }>;
    const updateGen = database.prepare("UPDATE gen_metadata SET data = ? WHERE idx = ?");
    for (const row of genRows) {
      if (!(row.data instanceof Uint8Array)) continue;
      const buf = Buffer.from(row.data);
      const updated = patchProtobufPath(buf, [3, 46], alignFilters);
      if (!updated.equals(buf)) {
        updateGen.run(updated, row.idx);
        modified = true;
      }
    }
    if (specVisited === 0) {
      throw new Error("no CustomAgentSpec record found in persisted conversation metadata");
    }
    database.exec("COMMIT");
    transactionStarted = false;
    return { status: modified ? "migrated" : "unchanged" };
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    if (transactionStarted && database) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) {
        detail += `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    }
    return {
      status: "failed",
      message: `antigravity：原生会话 ${conversationId} 的旧数据升级失败（${detail}）。` +
        (nativeTools.length === 0
          ? "闭卷原生过滤未确认，本轮不启动此会话；处理上述错误后重载重试。"
          : "本轮继续使用既有会话，提示词、原生工具与 512K 升级未确认；下一轮将自动重试，若持续失败请处理上述错误后重载。"),
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors.
    }
  }
}
