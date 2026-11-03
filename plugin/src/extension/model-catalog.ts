// Model discovery: `agy models` output cached on disk, with fallbacks that keep
// the model picker usable when the CLI cannot answer.

import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runAgyCommand } from "../driver/agy-diagnostics.ts";
import {
  type AgyModelInfo,
  FALLBACK_MODELS,
  mergeAgyModels,
  modelCacheTtlMs,
  parseAgyModels,
} from "../provider/models.ts";
import { readJson, writeJson } from "./config.ts";

const DISCOVERY_TIMEOUT_MS = 15_000;

export interface ModelCache {
  fetchedAt?: number;
  source?: "live" | "fallback";
  models: AgyModelInfo[];
  /** Last attempt's original failure; never persisted as a successful refresh. */
  discoveryError?: unknown;
}

/** Disk cache and CLI access; tests replace them. */
export interface ModelCatalogIo {
  readCache(): ModelCache | null;
  writeCache(cache: ModelCache): void;
  /** Raw `agy models` stdout. */
  listModels(): Promise<string>;
}

export async function execAgy(args: string[], timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  return (await runAgyCommand(args, { timeoutMs })).stdout;
}

export function defaultModelCatalogIo(): ModelCatalogIo {
  const file = path.join(getAgentDir(), "antigravity", "model-list.json");
  return {
    readCache: () => readJson<ModelCache | null>(file, null),
    writeCache: (cache) => writeJson(file, cache),
    listModels: () => execAgy(["models"]),
  };
}

/** Collapse effort variants and dedupe (also heals pre-0.2.0 caches). */
export function normalizeModels(models: AgyModelInfo[]): AgyModelInfo[] {
  return mergeAgyModels(models).map((model) => {
    if (model.supportedEfforts.length > 0) return model;
    const fallback = FALLBACK_MODELS.find((candidate) => candidate.id === model.id);
    return fallback?.supportedEfforts.length
      ? {
          ...model,
          supportedEfforts: [...fallback.supportedEfforts],
          defaultEffort: fallback.defaultEffort,
        }
      : model;
  });
}

export function modelDiscoveryFailure(cache: ModelCache): string {
  const error = cache.discoveryError;
  const detail = error instanceof Error ? error.message : String(error);
  const source = cache.source === "live" ? "last-known-good live" : "fallback";
  return `antigravity: model discovery failed (${detail}); using ${cache.models.length} ${source} models. No successful refresh recorded.`;
}

/** The model list currently registered with Pi. */
export class ModelCatalog {
  readonly #io: ModelCatalogIo;
  #cache: ModelCache;

  constructor(io: ModelCatalogIo = defaultModelCatalogIo()) {
    this.#io = io;
    const cached = io.readCache();
    this.#cache = cached?.models?.length
      ? { ...cached, models: normalizeModels(cached.models) }
      : { fetchedAt: 0, source: "fallback", models: FALLBACK_MODELS };
  }

  get cache(): ModelCache {
    return this.#cache;
  }

  get models(): AgyModelInfo[] {
    return this.#cache.models;
  }

  find(modelId: string | undefined): AgyModelInfo | undefined {
    return this.#cache.models.find((model) => model.id === modelId);
  }

  /** True while the last successful discovery is within its TTL. */
  isFresh(): boolean {
    const { fetchedAt, source } = this.#cache;
    if (!fetchedAt) return false;
    return Date.now() - fetchedAt < modelCacheTtlMs(source);
  }

  /** Re-run `agy models`. A failure keeps the catalog this call started from
   *  and its last-success time, including live results whose disk write failed;
   *  a concurrent refresh that finished meanwhile does not change that fallback. */
  async refresh(): Promise<ModelCache> {
    const previous = this.#cache;
    let live: AgyModelInfo[];
    try {
      live = parseAgyModels(await this.#io.listModels());
      if (!live.length) throw new Error("agy models returned no valid model rows.");
    } catch (discoveryError) {
      this.#cache = { ...previous, discoveryError };
      return this.#cache;
    }
    const cache: ModelCache = {
      fetchedAt: Date.now(), source: "live", models: normalizeModels(live),
    };
    try {
      this.#io.writeCache(cache);
    } catch {
      // Cache is best-effort; discovery still returns.
    }
    this.#cache = cache;
    return cache;
  }
}
