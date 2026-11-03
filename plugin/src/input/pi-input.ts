import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { storeImageAttachments } from "./image-input.ts";
import { attachedImagesPrompt, restoredPiContextPrompt } from "./prompt.ts";

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
  [k: string]: unknown;
}

const HOST_METADATA_TAGS = ["ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE", "SYSTEM_MESSAGE"] as const;

/** Unwrap Pi's host envelope only when its complete metadata shape is recognized. */
export function piUserRequestText(text: string): string {
  const opening = "<USER_REQUEST>\n";
  if (!text.startsWith(opening)) return text;
  const closing = "\n</USER_REQUEST>";
  const end = text.lastIndexOf(closing);
  if (end < opening.length) return text;
  const request = text.slice(opening.length, end);
  let tail = text.slice(end + closing.length);
  while (tail.trim()) {
    tail = tail.replace(/^\s+/, "");
    const tag = HOST_METADATA_TAGS.find((name) => tail.startsWith(`<${name}>`));
    if (!tag) return text;
    const close = `</${tag}>`;
    const blockEnd = tail.indexOf(close, tag.length + 2);
    if (blockEnd < 0) return text;
    tail = tail.slice(blockEnd + close.length);
  }
  return request;
}

/**
 * Pi Context has no caller/extension provenance. Preserve the latest contiguous
 * user-message batch in order, rather than letting its last message replace
 * the caller's request. Trailing assistant/tool messages are tool-loop re-entry.
 * Skip wholly empty batches, using the same boundary for history restoration.
 */
function latestUserBatch(context: Context): { start: number; end: number; prompt: string; images: ImagePart[] } {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role !== "user") continue;
    const end = i + 1;
    while (i > 0 && context.messages[i - 1].role === "user") i--;
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const message of context.messages.slice(i, end)) {
      if (typeof message.content === "string") {
        const text = piUserRequestText(message.content);
        if (text.trim()) texts.push(text);
        continue;
      }
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts as (TextPart | ImagePart)[]) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          const text = piUserRequestText(part.text);
          if (text.trim()) texts.push(text);
        } else if (part?.type === "image") {
          images.push(part);
        }
      }
    }
    if (texts.length === 0 && images.length === 0) continue;
    const prompt = texts.join("\n");
    return { start: i, end, prompt, images };
  }
  return { start: -1, end: -1, prompt: "", images: [] };
}

/** Adapt images only at the CLI boundary; Pi keeps the original user message. */
export function latestUserPrompt(context: Context, imageDirectory?: string): { prompt: string; images: number } {
  const { prompt, images } = latestUserBatch(context);
  const attachments = attachedImagesPrompt(storeImageAttachments(images, imageDirectory));
  return { prompt: [prompt, attachments].filter(Boolean).join("\n\n"), images: images.length };
}

// agy delivers at most 192,000 UTF-8 bytes of one USER_INPUT to the model and
// drops the rest (verified 2026-11-01: 184,968 bytes reached the model whole,
// 200,505 did not). The current request comes last, so a rebuilt conversation
// keeps the whole input below that limit, leaving room for the bridge note the
// runtime may insert before the request.
const MAX_NATIVE_INPUT_BYTES = 176_000;
const RESERVED_RECEIPT_BYTES = 16_000;
const RESERVED_IMAGE_PATH_BYTES = 512;
const MIN_RESTORED_HISTORY_BYTES = 8_000;
// Reserved from the history budget when the completed-work section is present.
const RESERVED_PROGRESS_HEADER_BYTES = 1_024;
// The current request keeps the rest of the native budget: with the 8,000-byte
// history floor and the reserved receipts a rebuilt input stays below 192,000.
const MAX_INLINE_REQUEST_BYTES = MAX_NATIVE_INPUT_BYTES - RESERVED_RECEIPT_BYTES;
const RESERVED_REQUEST_NOTICE_BYTES = 1_024;
const LINE_SNAP_BYTES = 4_096;
const SUMMARY_PREFIXES = [
  "The conversation history before this point was compacted into the following summary:",
  "The following is a summary of a branch that this conversation came back from:",
];

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function restoredHistoryBudget(prompt: string, images: number): number {
  const reserved = RESERVED_RECEIPT_BYTES + utf8Bytes(prompt) + images * RESERVED_IMAGE_PATH_BYTES +
    utf8Bytes(restoredPiContextPrompt("")) + 4;
  return Math.max(MIN_RESTORED_HISTORY_BYTES, MAX_NATIVE_INPUT_BYTES - reserved);
}

function storeArchive(text: string, kind: "history" | "requests", directory?: string): string {
  const target = directory ? path.join(directory, kind) : path.join(os.tmpdir(), `pi-antigravity-${kind}`);
  mkdirSync(target, { recursive: true });
  const hash = createHash("sha256").update(text).digest("hex");
  const file = path.resolve(target, `${hash}.txt`);
  if (!existsSync(file)) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, "utf8");
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return file;
}

const isContinuationByte = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

function countNewlines(bytes: Buffer, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index++) if (bytes[index] === 0x0a) count++;
  return count;
}

/**
 * agy hands the model only the first 192,000 bytes of one input and silently
 * drops the rest, which is where the actual ask (and Pi's summary instructions)
 * usually is. An oversized request keeps its beginning and end, cut at line
 * boundaries, and names the omitted lines; with native view_file the full
 * original is archived for reading. Deterministic, so tool-loop re-entries keep
 * the same request identity.
 */
export function fitNativeRequest(prompt: string, options: { readable?: boolean; directory?: string } = {}): string {
  const bytes = Buffer.from(prompt, "utf8");
  if (bytes.length <= MAX_INLINE_REQUEST_BYTES) return prompt;
  const keep = MAX_INLINE_REQUEST_BYTES - RESERVED_REQUEST_NOTICE_BYTES;
  let headEnd = Math.floor(keep / 2);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) headEnd--;
  const newlineBefore = bytes.lastIndexOf(0x0a, headEnd);
  if (newlineBefore >= 0 && headEnd - newlineBefore <= LINE_SNAP_BYTES) headEnd = newlineBefore;
  let tailStart = bytes.length - (keep - headEnd);
  while (tailStart < bytes.length && isContinuationByte(bytes[tailStart])) tailStart++;
  const newlineAfter = bytes.indexOf(0x0a, tailStart - 1);
  if (newlineAfter >= 0 && newlineAfter + 1 - tailStart <= LINE_SNAP_BYTES) tailStart = newlineAfter + 1;
  // A cut at a newline omits whole lines; a cut inside a long line names it too.
  const from = countNewlines(bytes, headEnd) + (bytes[headEnd] === 0x0a ? 2 : 1);
  const tailNewlines = countNewlines(bytes, tailStart);
  const to = bytes[tailStart - 1] === 0x0a ? tailNewlines : tailNewlines + 1;
  const range = `lines ${from}-${to}`;
  const notice = options.readable
    ? `[Request too long for one agy input (${bytes.length} bytes): ${range} are omitted below. Full original: ${JSON.stringify(storeArchive(prompt, "requests", options.directory))}. Read the omitted lines with native view_file before answering.]`
    : `[Request too long for one agy input (${bytes.length} bytes): the beginning and end are kept and ${range} are omitted.]`;
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return `${notice}\n\n${head}\n\n[... ${range} omitted (${tailStart - headEnd} bytes) ...]\n\n${tail}`;
}

interface TranscriptBlock {
  role: string;
  text: string;
  summary: boolean;
  /** Tool work already done for the current request. */
  progress: boolean;
  startLine: number;
  endLine: number;
}

/** Render messages as transcript blocks. With `completed`, keep only finished
 *  tool work: calls whose result is present, those results and the assistant
 *  text around them. */
function appendBlocks(
  blocks: TranscriptBlock[],
  messages: Context["messages"],
  imageDirectory: string | undefined,
  completed?: ReadonlySet<string>,
): void {
  for (const raw of messages) {
    if (raw.role === "system") continue;
    const message = raw as {
      role?: string;
      toolName?: string;
      content?: unknown;
    };
    if (completed && message.role !== "assistant" && message.role !== "toolResult") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const rawText = typeof message.content === "string" ? message.content : undefined;
    const rendered: string[] = rawText?.trim()
      ? [message.role === "user" ? piUserRequestText(rawText) : rawText]
      : [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        rendered.push(message.role === "user" ? piUserRequestText(part.text) : part.text);
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        rendered.push(attachedImagesPrompt(storeImageAttachments([{ data: part.data, mimeType: part.mimeType }], imageDirectory)));
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        if (completed && !(typeof part.id === "string" && completed.has(part.id))) continue;
        const args = JSON.stringify(part.arguments ?? {});
        rendered.push(`[tool call: ${part.name}${args === "{}" ? "" : ` ${args}`}]`);
      }
    }
    if (rendered.length === 0) continue;
    const role =
      message.role === "toolResult"
        ? `tool ${message.toolName ?? "result"}`
        : (message.role ?? "message");
    const text = `${role}:\n${rendered.join("\n")}`;
    const previous = blocks.at(-1);
    if (message.role === "toolResult" && previous?.role === "assistant") {
      previous.text += `\n\n${text}`;
    } else {
      const summary = message.role === "user" &&
        SUMMARY_PREFIXES.some((prefix) => rendered[0].startsWith(prefix));
      blocks.push({ role: message.role ?? "message", text, summary, progress: Boolean(completed), startLine: 0, endLine: 0 });
    }
  }
}

/** Serialize prior user messages and complete tool exchanges within the budget,
 *  plus tool work already completed for the current request: a rebuild with no
 *  new user message (e.g. a model switch mid tool loop) must not lose it. */
export function piHistoryBootstrap(context: Context, imageDirectory?: string): string | undefined {
  const { start: latestUser, end: requestEnd, prompt, images } = latestUserBatch(context);
  if (latestUser < 0) return undefined;
  const history: TranscriptBlock[] = [];
  appendBlocks(history, context.messages.slice(0, latestUser), imageDirectory);
  const trailing = context.messages.slice(requestEnd);
  const completed = new Set<string>();
  for (const message of trailing) {
    const id = (message as { toolCallId?: unknown }).toolCallId;
    if (message.role === "toolResult" && typeof id === "string") completed.add(id);
  }
  const progress: TranscriptBlock[] = [];
  if (completed.size > 0) appendBlocks(progress, trailing, imageDirectory, completed);
  if (history.length === 0 && progress.length === 0) return undefined;
  const budget = restoredHistoryBudget(prompt, images.length) - (progress.length ? RESERVED_PROGRESS_HEADER_BYTES : 0);

  const transcript = history.map((block) => block.text).join("\n\n");
  const completedWork = progress.map((block) => block.text).join("\n\n");
  if (utf8Bytes(transcript) + (progress.length ? utf8Bytes(completedWork) + 2 : 0) <= budget) {
    return restoredPiContextPrompt(transcript, completedWork || undefined);
  }

  const blocks = [...history, ...progress];
  const file = JSON.stringify(storeArchive(blocks.map((block) => block.text).join("\n\n"), "history", imageDirectory));
  const notice = `[History condensed at complete message/tool-exchange boundaries. Full prior transcript: ${file}. Use native view_file with the referenced line ranges for archived content.]`;
  let remaining = budget - utf8Bytes(notice) - 2;
  let line = 1;
  for (const block of blocks) {
    block.startLine = line;
    block.endLine = line + block.text.split("\n").length - 1;
    line = block.endLine + 2;
  }
  const newestFirst = blocks.map((_, index) => index).reverse();
  // Pi's compaction/branch summary is the only record of the folded history.
  const priority = [
    ...blocks.map((_, index) => index).filter((index) => blocks[index].summary),
    // Work already done for the current request is the freshest context.
    ...newestFirst.filter((index) => blocks[index].progress),
    ...newestFirst.filter((index) => blocks[index].role === "user" && !blocks[index].summary),
    ...newestFirst.filter((index) => blocks[index].role !== "user" && !blocks[index].progress),
  ];
  const selected = new Map<number, string>();
  for (const index of priority) {
    const block = blocks[index];
    let text = block.text;
    if (utf8Bytes(text) + 2 > remaining) {
      const kind = block.summary ? "summary" : block.role === "user" ? "user message" : "message/tool exchange";
      text = `${block.role}:\n[Archived ${kind}: ${file}, lines ${block.startLine}-${block.endLine}. Read the original when continuing this work.]`;
    }
    const size = utf8Bytes(text) + 2;
    if (size <= remaining) {
      selected.set(index, text);
      remaining -= size;
    }
  }
  const kept = (progressBlocks: boolean): string => [...selected]
    .filter(([index]) => blocks[index].progress === progressBlocks)
    .sort(([left], [right]) => left - right).map(([, text]) => text).join("\n\n");
  return restoredPiContextPrompt(`${notice}\n\n${kept(false)}`, kept(true) || undefined);
}

