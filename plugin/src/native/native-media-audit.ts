import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

export const NATIVE_MEDIA_ENTRY = "pi-antigravity-native-media";

type ProbeResult = Record<string, unknown>;
export type AttachmentProbe = (file: string, mime?: string) => ProbeResult;

export interface NativeMediaOptions {
  conversationId: string;
  cwd: string;
  dataDirectory?: string;
  probe?: AttachmentProbe;
}

export type NativeMediaRecord = Record<string, unknown> & {
  conversation_id: string;
  native_step: unknown;
  native_part_index: number;
  sha256: string;
};

/** One line of agy's transcript_full.jsonl, as far as the audit reads it. */
interface TranscriptStep {
  step_index?: number;
  created_at?: string;
  tool_calls?: { name?: string; args?: { AbsolutePath?: unknown } }[];
  media?: {
    uri?: unknown;
    part_id?: string;
    partId?: string;
    id?: string;
    mime_type?: string;
    duration_seconds?: unknown;
    frame_range?: unknown;
  }[];
}

type Fingerprint = { bytes?: number; sha256?: string; error?: string };

interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const localPath = (value: string, cwd: string): string =>
  value.startsWith("file:") ? fileURLToPath(value) : path.resolve(cwd, value);
const recordKey = (record: NativeMediaRecord): string =>
  `${record.conversation_id}:${record.native_step}:${record.native_part_index}:${record.sha256}`;

function probeAttachment(file: string, mime = ""): ProbeResult {
  if (!/^(audio|video)\//.test(mime)) return {};
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  if (result.error || result.status !== 0) return { metadata_status: "unavailable",
    metadata_error: (result.error as NodeJS.ErrnoException | undefined)?.code
      ?? result.stderr?.trim().slice(0, 500) ?? `ffprobe exit ${result.status}` };
  const value = JSON.parse(result.stdout) as { format?: { duration?: unknown } };
  const duration = Number(value.format?.duration);
  return Number.isFinite(duration)
    ? { duration_seconds: duration, duration_basis: "ffprobe-attachment-file" }
    : { metadata_status: "duration-not-reported" };
}

function fingerprint(file: string): Fingerprint {
  try {
    const source = fs.readFileSync(file);
    return { bytes: source.length, sha256: digest(source) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { error: failure.code ?? failure.message };
  }
}

/** Record attachments actually present in the native transcript, not model claims. */
export function collectNativeMedia(
  { conversationId, cwd, dataDirectory, probe = probeAttachment }: NativeMediaOptions,
): NativeMediaRecord[] {
  const transcript = path.join(resolveAgyDataDirectory(cwd, dataDirectory), "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  const requests = new Set<string>();
  const fingerprints = new Map<string, Fingerprint>();
  const records: NativeMediaRecord[] = [];
  for (const line of fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean)) {
    const step = JSON.parse(line) as TranscriptStep;
    for (const call of step.tool_calls ?? []) {
      const requested = call.args?.AbsolutePath;
      if (call.name === "view_file" && typeof requested === "string") requests.add(localPath(requested, cwd));
    }
    for (const [index, media] of (step.media ?? []).entries()) {
      if (typeof media.uri !== "string") continue;
      const attachment = localPath(media.uri, cwd);
      const bytes = fs.readFileSync(attachment);
      const sha256 = digest(bytes);
      const matches: string[] = [];
      for (const requested of requests) {
        let source = fingerprints.get(requested);
        if (!source) {
          source = fingerprint(requested);
          fingerprints.set(requested, source);
        }
        if (source.bytes === bytes.length && source.sha256 === sha256) matches.push(requested);
      }
      const nativePartId = media.part_id ?? media.partId ?? media.id;
      records.push({ status: "native-attachment-observed", conversation_id: conversationId,
        native_step: step.step_index, native_part_index: index,
        part_id: nativePartId ?? `step_${step.step_index}:part_${index}`,
        part_id_source: nativePartId === undefined ? "native-media-array-position" : "native-field",
        requested_paths: matches, source_match: matches.length ? "sha256-and-bytes" : "unmatched",
        attachment_path: attachment, bytes: bytes.length, sha256,
        mime_type: media.mime_type, observed_at: step.created_at, transcript,
        ...probe(attachment, media.mime_type),
        ...(media.duration_seconds !== undefined ? { duration_seconds: media.duration_seconds, duration_basis: "native-field" } : {}),
        ...(media.frame_range !== undefined ? { frame_range: media.frame_range } : {}),
      });
    }
  }
  return records;
}

export function persistNativeMedia(
  pi: { appendEntry(customType: string, data: unknown): void },
  { branch = [], ...options }: NativeMediaOptions & { branch?: readonly BranchEntry[] },
): void {
  const seen = new Set(branch.filter((entry) => entry.customType === NATIVE_MEDIA_ENTRY)
    .flatMap((entry) => (entry.data as { records?: NativeMediaRecord[] } | undefined)?.records ?? [])
    .map(recordKey));
  let records: NativeMediaRecord[];
  try {
    records = collectNativeMedia(options);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    pi.appendEntry(NATIVE_MEDIA_ENTRY, { version: 1, status: "unavailable", conversation_id: options.conversationId,
      error: { code: failure.code ?? "NATIVE_MEDIA_AUDIT_FAILED", message: failure.message } });
    return;
  }
  records = records.filter((record) => !seen.has(recordKey(record)));
  if (records.length) pi.appendEntry(NATIVE_MEDIA_ENTRY, { version: 1, status: "observed", records });
}
