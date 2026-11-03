import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MEDIA_CACHE_SETTLE_MS = Number(process.env.PI_AGY_MEDIA_CACHE_SETTLE_MS ?? 15_000);
export const MEDIA_CACHE_MIN_BYTES = Number(process.env.PI_AGY_MEDIA_CACHE_MIN_BYTES ?? 10_000_000);

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7n;
    if (shift > 63n) return undefined;
  }
  return undefined;
}

function decodeTimestampMs(buf, start, end) {
  let seconds = 0n;
  let nanos = 0n;
  let pos = start;
  while (pos < end) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const val = readVarint(buf, pos);
      if (!val) break;
      pos = val.next;
      if (field === 1) seconds = val.value;
      else if (field === 2) nanos = val.value;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.next + Number(len.value);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return seconds > 0n ? Number(seconds) * 1000 + Math.round(Number(nanos) / 1e6) : undefined;
}

/** Extract finished_generating_at (field 7) or completed_at (field 8) from CortexStepMetadata bytes. */
export function extractStepFinishedAtMs(metadata) {
  if (!metadata || metadata.length === 0) return undefined;
  let finishedMs;
  let completedMs;
  let pos = 0;
  while (pos < metadata.length) {
    const tag = readVarint(metadata, pos);
    if (!tag) break;
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const val = readVarint(metadata, pos);
      if (!val) break;
      pos = val.next;
    } else if (wire === 2) {
      const len = readVarint(metadata, pos);
      if (!len) break;
      const start = len.next;
      const end = start + Number(len.value);
      if (end > metadata.length) break;
      if (field === 7) finishedMs = decodeTimestampMs(metadata, start, end);
      else if (field === 8) completedMs = decodeTimestampMs(metadata, start, end);
      pos = end;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return finishedMs ?? completedMs;
}

/** Read the last completed PLANNER_RESPONSE (step_type=15, status=3) before beforeStep from native SQLite. */
export function readLastCompletedModelStep(dbPath, beforeStep) {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const query = Number.isFinite(beforeStep)
      ? db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx < ? ORDER BY idx DESC LIMIT 1")
      : db.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 ORDER BY idx DESC LIMIT 1");
    const row = Number.isFinite(beforeStep) ? query.get(beforeStep) : query.get();
    if (!row || row.idx === undefined) return undefined;
    const finishedAtMs = extractStepFinishedAtMs(row.metadata);
    if (finishedAtMs === undefined) return undefined;
    return { stepIdx: Number(row.idx), finishedAtMs };
  } finally {
    db.close();
  }
}

function resolveMediaPath(uri, cwd) {
  if (typeof uri !== "string" || !uri) return undefined;
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : path.resolve(cwd ?? process.cwd(), uri);
  } catch {
    return undefined;
  }
}

/** Sum unique retained media attachment bytes recorded in transcript_full.jsonl prior to beforeStep. */
export function sumRetainedMediaBytes(transcriptPath, beforeStep, cwd) {
  if (!fs.existsSync(transcriptPath)) return 0;
  const seen = new Set();
  let totalBytes = 0;
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line || !line.includes('"media"')) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number.isFinite(beforeStep) && typeof step.step_index === "number" && step.step_index >= beforeStep) {
      continue;
    }
    for (const item of step.media ?? []) {
      const mime = item?.mime_type ?? "";
      if (mime && !/^(image|audio|video)\//.test(mime)) continue;
      const resolved = resolveMediaPath(item?.uri, cwd);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        totalBytes += fs.statSync(resolved).size;
      } catch {
        // Ignore missing or transient attachment files.
      }
    }
  }
  return totalBytes;
}

/**
 * Enforce a minimum net gap (default 15s) after a completed model response in large-media
 * conversations (>= 10 MB retained media) before the next native model invocation begins.
 */
export async function runPreInvocationCacheHook(input, {
  now = Date.now,
  wait = sleep,
  settleMs = MEDIA_CACHE_SETTLE_MS,
  minMediaBytes = MEDIA_CACHE_MIN_BYTES,
  logPath = process.env.PI_AGY_MEDIA_CACHE_LOG,
} = {}) {
  const conversationId = input?.conversationId;
  const transcriptPath = input?.transcriptPath;
  const beforeStep = typeof input?.initialNumSteps === "number" ? input.initialNumSteps : undefined;
  if (!conversationId || !transcriptPath || (beforeStep !== undefined && beforeStep <= 1)) {
    return { waitedMs: 0, reason: "initial-or-missing-context" };
  }

  const dataDirectory = path.resolve(path.dirname(transcriptPath), "../../../..");
  const dbPath = path.join(dataDirectory, "conversations", `${conversationId}.db`);
  const lastModel = readLastCompletedModelStep(dbPath, beforeStep);
  if (!lastModel) {
    return { waitedMs: 0, reason: "no-prior-model-step" };
  }

  const currentNow = now();
  const elapsedMs = currentNow - lastModel.finishedAtMs;
  if (elapsedMs < 0 || elapsedMs >= settleMs) {
    return { waitedMs: 0, elapsedMs, lastModelStepIdx: lastModel.stepIdx, reason: "gap-already-satisfied" };
  }

  const fullTranscript = path.join(dataDirectory, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  const activeTranscript = fs.existsSync(fullTranscript) ? fullTranscript : transcriptPath;
  const cwd = input?.workspacePaths?.[0];
  const retainedMediaBytes = sumRetainedMediaBytes(activeTranscript, lastModel.stepIdx, cwd);
  if (retainedMediaBytes < minMediaBytes) {
    return {
      waitedMs: 0,
      elapsedMs,
      lastModelStepIdx: lastModel.stepIdx,
      retainedMediaBytes,
      reason: "below-media-threshold",
    };
  }

  const waitedMs = Math.min(settleMs, Math.max(0, settleMs - elapsedMs));
  if (waitedMs > 0) {
    await wait(waitedMs);
    if (logPath) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${JSON.stringify({
        conversationId,
        invocationNum: input.invocationNum,
        lastModelStepIdx: lastModel.stepIdx,
        retainedMediaBytes,
        elapsedMs,
        waitedMs,
      })}\n`);
    }
  }
  return {
    waitedMs,
    elapsedMs,
    lastModelStepIdx: lastModel.stepIdx,
    retainedMediaBytes,
    reason: "paced-large-media-gap",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    const input = raw ? JSON.parse(raw) : {};
    await runPreInvocationCacheHook(input);
  } catch {
    // Fail-open so a hook IO error never blocks a model invocation.
  }
  process.stdout.write("{}\n");
}
