import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ImageAttachment {
  /** Base64 image bytes. */
  data: string;
  mimeType: string;
}

/** A session entry as far as image restoration reads it. */
interface ImageSourceEntry {
  type: string;
  message?: { role?: string; content?: unknown };
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

/** Cache recorded image bytes for agy's native view_file, outside chat text. */
export function storeImageAttachments(
  images: readonly ImageAttachment[],
  directory = path.join(os.tmpdir(), "pi-antigravity-images"),
): string[] {
  if (!images.length) return [];
  mkdirSync(directory, { recursive: true });
  return images.map(({ data, mimeType }) => {
    const bytes = Buffer.from(data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = EXTENSIONS[mimeType] || "image";
    const file = path.resolve(directory, `${hash}.${extension}`);
    if (!existsSync(file)) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes);
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return file;
  });
}

/** Restore the active branch's original images, including pre-compaction entries. */
export function rehydrateSessionImages(entries: readonly ImageSourceEntry[], directory?: string): string[] {
  const images = entries.flatMap((entry) => {
    const role = entry.message?.role;
    if (entry.type !== "message" || (role !== "user" && role !== "toolResult")) return [];
    const content = entry.message?.content;
    return Array.isArray(content)
      ? (content as Array<{ type?: string }>).filter((part) => part.type === "image") as ImageAttachment[]
      : [];
  });
  return storeImageAttachments(images, directory);
}
