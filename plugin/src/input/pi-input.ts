import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { storeImageAttachments } from "./image-input.ts";
import {
  attachedImagesPrompt,
  restoredPiContextPrefillPrompt,
  restoredPiContextPrompt,
} from "./prompt.ts";

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
// Up to 4 low-effort ACK prefill turns + 1 final request turn (~800-880 KB total)
// keep every single USER_INPUT well below AGY's 192,000-byte cliff.
export const MAX_RESTORED_HISTORY_CHUNKS = 5;
export const MAX_PREFILL_CHUNKS = MAX_RESTORED_HISTORY_CHUNKS - 1;
export const MAX_PREFILL_CHUNK_BYTES = 172_000;
const PREFILL_FINAL_HEADER_EXTRA_BYTES = 256;
// The current request keeps the rest of the native budget: with the 8,000-byte
// history floor and the reserved receipts a rebuilt input stays below 192,000.
const MAX_INLINE_REQUEST_BYTES = MAX_NATIVE_INPUT_BYTES - RESERVED_RECEIPT_BYTES;
const RESERVED_REQUEST_NOTICE_BYTES = 1_024;
const LINE_SNAP_BYTES = 4_096;
// agy's McpHandler.Handle offloads the entire MCP tool output to steps/<N>/output.txt
// as soon as the joined text exceeds McpToolConfig.MaxOutputBytes (10,240 UTF-8 bytes).
export const MAX_BRIDGE_OUTPUT_BYTES = 10_240;
const BRIDGE_LINE_SNAP_BYTES = 512;
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

const MAX_ARCHIVE_DIR_BYTES = 1_024;

function storeArchive(text: string, kind: "history" | "requests" | "tool-output", directory?: string): string {
  let target = directory ? path.join(directory, kind) : path.join(os.tmpdir(), `pi-antigravity-${kind}`);
  if (utf8Bytes(target) > MAX_ARCHIVE_DIR_BYTES) {
    const localTemp = path.join(process.env.LOCALAPPDATA || os.homedir(), "Temp", `pi-antigravity-${kind}`);
    target = utf8Bytes(localTemp) <= MAX_ARCHIVE_DIR_BYTES
      ? localTemp
      : path.join(os.homedir(), ".gemini", "antigravity-cli", `pi-antigravity-${kind}`);
  }
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

/**
 * agy replaces any MCP tool output over 10,240 UTF-8 bytes with a bare
 * `The output was large and was saved to: file:///.../output.txt` pointer,
 * hiding both the beginning and the trailing summary/error. Keep the head and
 * tail inline within the 10 KiB budget and archive the full output for
 * view_file when native file reading is available.
 */
export function fitBridgeToolOutput(
  text: string,
  options: { readable?: boolean; directory?: string; maxBytes?: number } = {},
): string {
  const maxBytes = Math.max(1_024, options.maxBytes ?? MAX_BRIDGE_OUTPUT_BYTES);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const readable = options.readable !== false;
  let file = readable ? JSON.stringify(storeArchive(text, "tool-output", options.directory)) : undefined;
  const totalLines = countNewlines(bytes, bytes.length) + 1;
  const maxRange = `lines ${totalLines}-${totalLines}`;
  const buildNotice = (rangeText: string, fileRef: string | undefined): string =>
    fileRef
      ? `[Tool output too long for inline MCP delivery (${bytes.length} bytes): ${rangeText} are omitted below. Full output: ${fileRef}. Use native view_file with StartLine/EndLine if you need the omitted lines.]`
      : `[Tool output too long for inline MCP delivery (${bytes.length} bytes): the beginning and end are kept and ${rangeText} are omitted.]`;
  const maxMiddle = `[... ${maxRange} omitted (${bytes.length} bytes) ...]`;
  let overhead = utf8Bytes(buildNotice(maxRange, file)) + utf8Bytes(maxMiddle) + 6;
  if (file && overhead + 64 > maxBytes) {
    file = undefined;
    overhead = utf8Bytes(buildNotice(maxRange, undefined)) + utf8Bytes(maxMiddle) + 6;
  }
  const keep = Math.max(64, maxBytes - overhead);
  let headEnd = Math.floor(keep / 2);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) headEnd--;
  const newlineBefore = bytes.lastIndexOf(0x0a, headEnd);
  if (newlineBefore > 0 && headEnd - newlineBefore <= BRIDGE_LINE_SNAP_BYTES) headEnd = newlineBefore;
  let tailStart = bytes.length - (keep - headEnd);
  while (tailStart < bytes.length && isContinuationByte(bytes[tailStart])) tailStart++;
  const newlineAfter = bytes.indexOf(0x0a, tailStart - 1);
  if (
    newlineAfter >= 0 &&
    newlineAfter + 1 < bytes.length &&
    newlineAfter + 1 - tailStart <= BRIDGE_LINE_SNAP_BYTES
  ) {
    tailStart = newlineAfter + 1;
  }
  const from = countNewlines(bytes, headEnd) + (bytes[headEnd] === 0x0a ? 2 : 1);
  const tailNewlines = countNewlines(bytes, tailStart);
  const to = bytes[tailStart - 1] === 0x0a ? tailNewlines : tailNewlines + 1;
  const range = `lines ${from}-${to}`;
  const notice = buildNotice(range, file);
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

export interface PiHistoryBootstrapPlan {
  prefill: string[];
  bootstrap: string | undefined;
}

/**
 * Pack chronological history block byte-lengths from newest to oldest: fill the
 * final turn's history slot first (minimizing both prefill turn count and
 * cumulative prefill input tokens), then pack earlier blocks into `<= maxPrefillChunks`
 * chunks each bounded by `MAX_PREFILL_CHUNK_BYTES`.
 */
function packHistoryRightToLeft(
  sizes: readonly number[],
  finalHistoryBudget: number,
  maxPrefillChunks: number,
): { prefillRanges: Array<[number, number]>; finalStart: number } | null {
  let cursor = sizes.length;
  let finalBytes = 0;
  while (cursor > 0) {
    const next = sizes[cursor - 1];
    const added = finalBytes === 0 ? next : next + 2;
    if (finalBytes + added > finalHistoryBudget) break;
    finalBytes += added;
    cursor -= 1;
  }
  const finalStart = cursor;
  if (cursor === 0) return { prefillRanges: [], finalStart: 0 };
  if (maxPrefillChunks <= 0) return null;

  const reversedRanges: Array<[number, number]> = [];
  while (cursor > 0) {
    if (reversedRanges.length >= maxPrefillChunks) return null;
    const end = cursor;
    let chunkBytes = 0;
    while (cursor > 0) {
      const next = sizes[cursor - 1];
      const added = chunkBytes === 0 ? next : next + 2;
      if (chunkBytes + added > MAX_PREFILL_CHUNK_BYTES) break;
      chunkBytes += added;
      cursor -= 1;
    }
    if (cursor === end) return null;
    reversedRanges.push([cursor, end]);
  }
  return { prefillRanges: reversedRanges.reverse(), finalStart };
}

/**
 * Build up to `MAX_RESTORED_HISTORY_CHUNKS` (`4` prefill + `1` final) restored
 * context inputs so histories up to ~800 KB stay 100% inline without hitting
 * AGY's 192,000-byte per-turn USER_INPUT cliff. Oversized individual blocks or
 * histories exceeding total multi-chunk capacity fall back to line-ranged
 * archive pointers in priority order.
 */
export function piHistoryBootstrapChunks(
  context: Context,
  imageDirectory?: string,
  maxPrefillChunks = MAX_PREFILL_CHUNKS,
): PiHistoryBootstrapPlan {
  const { start: latestUser, end: requestEnd, prompt, images } = latestUserBatch(context);
  if (latestUser < 0) return { prefill: [], bootstrap: undefined };
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
  if (history.length === 0 && progress.length === 0) return { prefill: [], bootstrap: undefined };
  const budget = restoredHistoryBudget(prompt, images.length) - (progress.length ? RESERVED_PROGRESS_HEADER_BYTES : 0);

  const transcript = history.map((block) => block.text).join("\n\n");
  const completedWork = progress.map((block) => block.text).join("\n\n");
  const progressBytes = progress.length ? utf8Bytes(completedWork) : 0;
  if (utf8Bytes(transcript) + (progress.length ? progressBytes + 2 : 0) <= budget) {
    return {
      prefill: [],
      bootstrap: restoredPiContextPrompt(transcript, completedWork || undefined),
    };
  }

  const prefillFinalBudget = Math.max(0, budget - PREFILL_FINAL_HEADER_EXTRA_BYTES);
  if (maxPrefillChunks > 0 && progressBytes <= prefillFinalBudget) {
    const historySizes = history.map((block) => utf8Bytes(block.text));
    const finalHistoryBudget = Math.max(
      0,
      prefillFinalBudget - (progress.length ? progressBytes + 2 : 0),
    );
    const packed = packHistoryRightToLeft(historySizes, finalHistoryBudget, maxPrefillChunks);
    if (packed) {
      const totalPrefill = packed.prefillRanges.length;
      const prefill = packed.prefillRanges.map(([start, end], idx) =>
        restoredPiContextPrefillPrompt(
          history.slice(start, end).map((block) => block.text).join("\n\n"),
          idx + 1,
          totalPrefill,
        ),
      );
      const finalTranscript = history
        .slice(packed.finalStart)
        .map((block) => block.text)
        .join("\n\n");
      return {
        prefill,
        bootstrap: restoredPiContextPrompt(
          finalTranscript,
          completedWork || undefined,
          totalPrefill,
        ),
      };
    }
  }

  const blocks = [...history, ...progress];
  const file = JSON.stringify(storeArchive(blocks.map((block) => block.text).join("\n\n"), "history", imageDirectory));
  const notice = `[History condensed at complete message/tool-exchange boundaries. Full prior transcript: ${file}. Use native view_file with the referenced line ranges for archived content.]`;
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
  const archivedTextFor = (block: TranscriptBlock): string => {
    const kind = block.summary ? "summary" : block.role === "user" ? "user message" : "message/tool exchange";
    return `${block.role}:\n[Archived ${kind}: ${file}, lines ${block.startLine}-${block.endLine}. Read the original when continuing this work.]`;
  };

  if (maxPrefillChunks <= 0) {
    let remaining = budget - utf8Bytes(notice) - 2;
    const selected = new Map<number, string>();
    for (const index of priority) {
      const block = blocks[index];
      let text = block.text;
      if (utf8Bytes(text) + 2 > remaining) {
        text = archivedTextFor(block);
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
    return {
      prefill: [],
      bootstrap: restoredPiContextPrompt(`${notice}\n\n${kept(false)}`, kept(true) || undefined),
    };
  }

  const noticeBytes = utf8Bytes(notice);
  const fullTexts = blocks.map((block) => block.text);
  const fullSizes = fullTexts.map((text) => utf8Bytes(text));
  const archivedTexts = blocks.map((block) => archivedTextFor(block));
  const archivedSizes = archivedTexts.map((text) => utf8Bytes(text));
  const chosenSizes = new Map<number, number>();
  const chosenTexts = new Map<number, string>();

  const evaluatePacking = () => {
    const histIndices: number[] = [];
    const histSizes: number[] = [];
    let progBytes = 0;
    let progCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      const size = chosenSizes.get(i);
      if (size === undefined) continue;
      if (blocks[i].progress) {
        progBytes += progCount === 0 ? size : size + 2;
        progCount += 1;
      } else {
        histIndices.push(i);
        histSizes.push(size);
      }
    }
    if (histSizes.length === 0) {
      return noticeBytes + (progCount > 0 ? progBytes + 2 : 0) <= budget
        ? { histIndices, prefillRanges: [] as Array<[number, number]>, finalStart: 0 }
        : null;
    }
    histSizes[0] += noticeBytes + 2;
    // Try fitting into the single final turn first (0 prefill turns).
    if (progBytes <= budget) {
      const singleFinalHistory = Math.max(0, budget - (progCount > 0 ? progBytes + 2 : 0));
      const single = packHistoryRightToLeft(histSizes, singleFinalHistory, 0);
      if (single) return { histIndices, ...single };
    }
    if (progBytes > prefillFinalBudget) return null;
    const finalHistoryBudget = Math.max(
      0,
      prefillFinalBudget - (progCount > 0 ? progBytes + 2 : 0),
    );
    const multi = packHistoryRightToLeft(histSizes, finalHistoryBudget, maxPrefillChunks);
    return multi ? { histIndices, ...multi } : null;
  };

  // Pass 1: include archive pointers in priority order so chronological breadcrumbs stay intact.
  for (const index of priority) {
    chosenSizes.set(index, archivedSizes[index]);
    chosenTexts.set(index, archivedTexts[index]);
    if (!evaluatePacking()) {
      chosenSizes.delete(index);
      chosenTexts.delete(index);
    }
  }
  // Pass 2: upgrade selected entries to full inline text in strict priority order.
  for (const index of priority) {
    if (!chosenSizes.has(index)) continue;
    chosenSizes.set(index, fullSizes[index]);
    chosenTexts.set(index, fullTexts[index]);
    if (!evaluatePacking()) {
      chosenSizes.set(index, archivedSizes[index]);
      chosenTexts.set(index, archivedTexts[index]);
    }
  }

  const finalPack = evaluatePacking();
  const keptProgress = [...chosenTexts]
    .filter(([index]) => blocks[index].progress)
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("\n\n");
  if (!finalPack || finalPack.histIndices.length === 0) {
    return {
      prefill: [],
      bootstrap: restoredPiContextPrompt(notice, keptProgress || undefined),
    };
  }
  const renderedHistory = finalPack.histIndices.map((blockIdx, pos) => {
    const body = chosenTexts.get(blockIdx) ?? "";
    return pos === 0 ? `${notice}\n\n${body}` : body;
  });
  const totalPrefill = finalPack.prefillRanges.length;
  const prefill = finalPack.prefillRanges.map(([start, end], idx) =>
    restoredPiContextPrefillPrompt(
      renderedHistory.slice(start, end).join("\n\n"),
      idx + 1,
      totalPrefill,
    ),
  );
  const finalTranscript = renderedHistory.slice(finalPack.finalStart).join("\n\n");
  return {
    prefill,
    bootstrap: restoredPiContextPrompt(
      finalTranscript,
      keptProgress || undefined,
      totalPrefill,
    ),
  };
}

/** Serialize prior user messages and complete tool exchanges within the single-input
 *  budget, plus tool work already completed for the current request. */
export function piHistoryBootstrap(context: Context, imageDirectory?: string): string | undefined {
  return piHistoryBootstrapChunks(context, imageDirectory, 0).bootstrap;
}

