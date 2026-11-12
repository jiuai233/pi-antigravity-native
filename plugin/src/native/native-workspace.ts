import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BRIDGE_CALL_TIMEOUT_MS, canonicalToolDefinitions, type PiToolInfo } from "../extension/bridge.ts";
import { executionSurface, type NativeProfile } from "./native-profile.ts";
import { bridgeToolName, bridgeToolNames } from "./native-tool-names.ts";
import { removeDeadBridgeLease, STABLE_BRIDGE_SERVER_PATTERN } from "./bridge-identity.ts";

/**
 * agy's per-server MCP limit (`timeoutSeconds`, default 180s per tool call). It must
 * outlast the bridge cap so agy never abandons a call that Pi is still running: an
 * abandoned call leaves the Pi command orphaned and later bridge calls queued behind it.
 */
export const AGY_MCP_TIMEOUT_SECONDS = Math.ceil(BRIDGE_CALL_TIMEOUT_MS / 1000) + 60;

/** The subset of JSON Schema the catalog hints read. */
interface JsonSchema {
  type?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
}

export interface NativeWorkspaceOptions {
  cwd: string;
  id: string;
  serverName?: string;
  /** agy's data directory; defaults to JETSKI_APP_DATA_DIR or ~/.gemini/antigravity-cli. */
  dataDirectory?: string;
  /** Pi agent directory that holds this instance's private MCP discovery directory. */
  agentDir: string;
  agentRoot?: string;
}

function emptyDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch {
    // Keep directories containing externally owned files.
  }
}

export function createNativeAgentMarkdown(
  name: string,
  systemPrompt: string,
  profile: NativeProfile = executionSurface.profiles.default,
  cacheHookName?: string,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid Antigravity agent name.");
  const hooks = cacheHookName ? "hooks: [hooks.json]\n" : "";
  return `---\nname: ${name}\ndescription: Pi-native Antigravity agent.\nmainAgent: true\nsubagent: false\nexcludeDefaultComponents: true\ninheritCustomizations: false\ntools: [${profile.native_tools.join(", ")}]\n${hooks}---\n\n${systemPrompt.replace(/\s+$/, "")}\n`;
}

/** Short MCP server name leaves room for readable tool ids within the CLI's 64-character limit. */
export function cliServerName(id: string): string {
  const suffix = String(id).replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  if (suffix.length < 8) throw new Error("Antigravity session id is too short for a CLI server name.");
  return `b${suffix}`;
}

export function cliToolName(serverName: string, toolName: string, toolPrefix = ""): string {
  return `mcp_${serverName}_${bridgeToolName(serverName, toolName, toolPrefix)}`;
}

export function resolveAgyDataDirectory(
  cwd = process.cwd(),
  dataDirectory = process.env.JETSKI_APP_DATA_DIR ?? path.join(os.homedir(), ".gemini", "antigravity-cli"),
): string {
  return path.resolve(cwd, dataDirectory);
}

function parameterHint(schema: JsonSchema = {}): string {
  const variants = schema.anyOf ?? schema.oneOf;
  const values = schema.enum ?? (variants?.every((item) => Object.hasOwn(item, "const"))
    ? variants.map((item) => item.const) : undefined);
  if (values?.length && values.length <= 5 && values.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))) {
    return values.map((value) => JSON.stringify(value)).join("|");
  }
  if (schema.type === "array") {
    const itemHint = parameterHint(schema.items);
    return itemHint ? `${itemHint.includes("|") ? `(${itemHint})` : itemHint}[]` : "";
  }
  return schema.type === "object" && schema.required?.length
    ? `{${schema.required.join(",")}}` : "";
}

/** Owns one instance's private MCP discovery directory and global custom agent. */
export class NativeWorkspaceRegistration {
  // Declared in assignment order so instances keep their property order.
  readonly cwd: string;
  readonly id: string;
  readonly agentName: string;
  readonly serverName: string;
  readonly toolPrefix: string;
  readonly schemaDirectory: string;
  readonly directory: string;
  readonly configPath: string;
  readonly cacheHookName: string;
  readonly agentDirectory: string;
  readonly agentPath: string;
  readonly cacheHooksPath: string;
  readonly cacheHookScriptPath: string;

  constructor({ cwd, id, serverName, dataDirectory, agentDir,
    agentRoot = path.join(os.homedir(), ".gemini", "config", "agents") }: NativeWorkspaceOptions) {
    this.cwd = path.resolve(cwd);
    this.id = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!this.id) throw new Error("A process/session identity is required for workspace registration.");
    this.agentName = `pi-native-${this.id}`;
    this.serverName = serverName ?? cliServerName(this.id);
    this.toolPrefix = "";
    this.schemaDirectory = path.join(resolveAgyDataDirectory(this.cwd, dataDirectory), "mcp", this.serverName);
    this.directory = path.join(agentDir, "antigravity", "bridges", this.id);
    this.configPath = path.join(this.directory, ".agents", "mcp_config.json");
    this.cacheHookName = `pi-media-cache-${this.id}`;
    this.agentDirectory = path.join(agentRoot, this.agentName);
    this.agentPath = path.join(this.agentDirectory, "agent.md");
    this.cacheHooksPath = path.join(this.agentDirectory, "hooks.json");
    this.cacheHookScriptPath = path.join(this.agentDirectory, "native-cache-hook.mjs");
  }

  #agentContent: string | undefined;
  #agentBody: string | undefined;
  #mcpContent: string | undefined;

  /** Markdown body written to agent.md (without YAML frontmatter). */
  get agentBody(): string | undefined {
    return this.#agentBody;
  }
  #cacheHooksContent: string | undefined;
  #cacheHookScriptContent: string | undefined;
  #profile: NativeProfile = executionSurface.profiles.default;
  #tools: readonly PiToolInfo[] = [];

  get routingHint(): string {
    if (!this.#profile.native_tools.includes("view_file")) {
      const schemas = this.#tools.map(({ name, description, parameters }) => ({
        name: bridgeToolName(this.serverName, name, this.toolPrefix), description, parameters,
      }));
      return `<pi_tool_bridge>\nSubmit through call_mcp_tool with ServerName "${this.serverName}" and ToolName "<Pi tool name>" from the catalog (long Pi names use stable aliases). Pass arguments unchanged in Arguments. Complete parameter schemas are inline below; use the supplied dossier without opening files.\n<pi_tool_schemas>\n${JSON.stringify(schemas)}\n</pi_tool_schemas>\n</pi_tool_bridge>`;
    }
    const schemaFile = JSON.stringify(path.join(this.schemaDirectory, "<Pi tool name>.json"));
    return `<pi_tool_bridge>\nPi tools are available through call_mcp_tool. Set ServerName to "${this.serverName}" and ToolName to the exact catalog name (long Pi names use stable aliases); pass the Pi tool arguments unchanged in Arguments. In the catalog, ? marks an optional parameter. Use the catalog signatures and descriptions to call tools directly. If you need more parameter details, read full parameter definitions with native view_file at ${schemaFile}, replacing <Pi tool name> with the catalog name; the file's parameters field contains its JSON schema.\n</pi_tool_bridge>`;
  }

  writeSystemPrompt(
    systemPrompt: string,
    tools: readonly PiToolInfo[] = [],
    profile: NativeProfile = executionSurface.profiles.default,
  ): boolean {
    bridgeToolNames(this.serverName, tools.map((tool) => tool.name), this.toolPrefix);
    this.#profile = profile;
    this.#tools = canonicalToolDefinitions(tools);
    const catalog = this.#tools.map(({ name, description, parameters }) => {
      const schema = parameters as JsonSchema | undefined;
      const required = new Set(schema?.required ?? []);
      const fields = Object.entries(schema?.properties ?? {}).map(([field, fieldSchema]) => {
        const hint = parameterHint(fieldSchema);
        return `${field}${required.has(field) ? "" : "?"}${hint ? `:${hint}` : ""}`;
      });
      const alias = bridgeToolName(this.serverName, name, this.toolPrefix);
      const origin = alias === `${this.toolPrefix}${name}` ? "" : ` [Pi: ${name}]`;
      return `- ${alias}(${fields.join(", ")}): ${description}${origin}`;
    }).join("\n");
    // Resolve connections from the private discovery directory, not agent
    // frontmatter: CLI restore retains inline MCP endpoints from the old instance.
    const catalogHint = profile.id === "evidence_only_v1"
      ? "Names below are the active Pi submission tools for this closed dossier."
      : "Names below are the current SDK tool declarations on this bridge.";
    const cacheHookName = profile.native_tools.includes("view_file") ? this.cacheHookName : undefined;
    const body = `${systemPrompt}\n\n${this.routingHint}\n\n<pi_active_tools>\n${catalogHint}\n${catalog}\n</pi_active_tools>`.replace(/\s+$/, "");
    const content = createNativeAgentMarkdown(this.agentName, body, profile, cacheHookName);
    if (this.#agentContent === content) {
      this.#agentBody = body;
      return false;
    }
    if (this.#agentContent === undefined && fs.existsSync(this.agentPath)) {
      throw new Error(`Refusing to overwrite an existing agent: ${this.agentPath}`);
    }
    if (this.#agentContent !== undefined) {
      const current = fs.readFileSync(this.agentPath, "utf8");
      if (current !== this.#agentContent) {
        throw new Error(`Agent file changed outside this session: ${this.agentPath}`);
      }
    }
    fs.mkdirSync(this.agentDirectory, { recursive: true, mode: 0o700 });
    if (cacheHookName && this.#cacheHooksContent === undefined) {
      const scriptSource = fs.readFileSync(new URL("./native-cache-hook.mjs", import.meta.url), "utf8");
      const hooks = {
        [cacheHookName]: {
          PreInvocation: [
            { type: "command", command: "node --no-warnings ./native-cache-hook.mjs", timeout: 30 },
          ],
        },
      };
      this.#cacheHooksContent = `${JSON.stringify(hooks, null, 2)}\n`;
      this.#cacheHookScriptContent = scriptSource;
      fs.writeFileSync(this.cacheHookScriptPath, this.#cacheHookScriptContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.writeFileSync(this.cacheHooksPath, this.#cacheHooksContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } else if (!cacheHookName && this.#cacheHooksContent !== undefined) {
      this.#removeCacheHooks();
    }
    fs.writeFileSync(this.agentPath, content, { encoding: "utf8", mode: 0o600 });
    this.#agentContent = content;
    this.#agentBody = body;
    return true;
  }

  registerMcpServer(url: string, token: string): void {
    if (this.#mcpContent !== undefined) return;
    const entry = { serverUrl: url, headers: { "x-pi-bridge-token": token }, timeoutSeconds: AGY_MCP_TIMEOUT_SECONDS };
    const content = `${JSON.stringify({ mcpServers: { [this.serverName]: entry } }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.configPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    this.#mcpContent = content;
    if (STABLE_BRIDGE_SERVER_PATTERN.test(this.serverName)) {
      fs.writeFileSync(path.join(this.directory, "bridge-owner.json"),
        JSON.stringify({ version: 1, id: this.id, serverName: this.serverName }),
        { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }

  dispose(): void {
    const removedRegistration = this.#removeMcpServer();
    this.#removeCacheHooks();
    if (this.#agentContent !== undefined && fs.existsSync(this.agentPath)) {
      if (fs.readFileSync(this.agentPath, "utf8") === this.#agentContent) {
        fs.unlinkSync(this.agentPath);
        emptyDirectory(this.agentDirectory);
      }
    }
    if (removedRegistration) fs.rmSync(this.schemaDirectory, { recursive: true, force: true });
    this.#agentContent = undefined;
    this.#agentBody = undefined;
  }

  #removeCacheHooks(): void {
    if (this.#cacheHooksContent === undefined) return;
    if (fs.existsSync(this.cacheHooksPath) && fs.readFileSync(this.cacheHooksPath, "utf8") === this.#cacheHooksContent) {
      fs.unlinkSync(this.cacheHooksPath);
    }
    if (this.#cacheHookScriptContent !== undefined && fs.existsSync(this.cacheHookScriptPath)
      && fs.readFileSync(this.cacheHookScriptPath, "utf8") === this.#cacheHookScriptContent) {
      fs.unlinkSync(this.cacheHookScriptPath);
    }
    emptyDirectory(this.agentDirectory);
    this.#cacheHooksContent = undefined;
    this.#cacheHookScriptContent = undefined;
  }

  #removeMcpServer(): boolean {
    if (this.#mcpContent === undefined) return false;
    if (fs.existsSync(this.configPath) && fs.readFileSync(this.configPath, "utf8") !== this.#mcpContent) return false;
    fs.rmSync(this.directory, { recursive: true, force: true });
    this.#mcpContent = undefined;
    return true;
  }
}

const DEAD_WORKSPACE_ID_PATTERN = /^p([1-9]\d*)-[0-9a-f]{12}$/;
const DEAD_AGENT_DIR_PATTERN = /^pi-native-(p[1-9]\d*-[0-9a-f]{12})$/;
const MAX_DEAD_WORKSPACES_PER_SWEEP = 32;

function defaultIsDeadPid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

export interface SweepDeadWorkspacesOptions {
  cwd: string;
  agentDir?: string;
  agentRoot?: string;
  dataDirectory?: string;
  maxEntries?: number;
  excludeId?: string;
  isDeadPid?: (pid: number) => boolean;
}

/**
 * Best-effort cleanup of `p<pid>-<12hex>` bridge workspaces left behind by dead
 * host processes (e.g. hard termination on Windows where `process.once("exit")`
 * cannot run). Removes only the three exact paths derived from a confirmed
 * `ESRCH` PID; never touches native conversations, brain, presence, live/EPERM
 * PIDs, or non-matching directory names.
 */
export function sweepDeadNativeWorkspaces(options: SweepDeadWorkspacesOptions): string[] {
  const {
    cwd,
    agentDir = path.join(os.homedir(), ".pi", "agent"),
    agentRoot = path.join(os.homedir(), ".gemini", "config", "agents"),
    dataDirectory,
    maxEntries = MAX_DEAD_WORKSPACES_PER_SWEEP,
    excludeId,
    isDeadPid = defaultIsDeadPid,
  } = options;
  const swept: string[] = [];
  try {
    const bridgesRoot = path.join(agentDir, "antigravity", "bridges");
    const candidates = new Set<string>();
    if (fs.existsSync(bridgesRoot)) {
      for (const entry of fs.readdirSync(bridgesRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && DEAD_WORKSPACE_ID_PATTERN.test(entry.name)) {
          candidates.add(entry.name);
        }
      }
    }
    if (fs.existsSync(agentRoot)) {
      for (const entry of fs.readdirSync(agentRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = DEAD_AGENT_DIR_PATTERN.exec(entry.name);
        if (match) candidates.add(match[1]);
      }
    }
    if (!candidates.size) return swept;
    const agyDataDir = resolveAgyDataDirectory(path.resolve(cwd), dataDirectory);
    for (const id of candidates) {
      if (swept.length >= maxEntries) break;
      if (id === excludeId) continue;
      const match = DEAD_WORKSPACE_ID_PATTERN.exec(id);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!isDeadPid(pid)) continue;
      let serverName = cliServerName(id);
      const bridgeDir = path.join(bridgesRoot, id);
      const configPath = path.join(bridgeDir, ".agents", "mcp_config.json");
      const ownerPath = path.join(bridgeDir, "bridge-owner.json");
      if (fs.existsSync(ownerPath)) {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          if (owner.version !== 1 || owner.id !== id || !STABLE_BRIDGE_SERVER_PATTERN.test(owner.serverName)) continue;
          serverName = owner.serverName;
        } catch { continue; }
      }
      if (fs.existsSync(configPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
          const keys = Object.keys(parsed?.mcpServers ?? {});
          if (keys.length !== 1 || keys[0] !== serverName) continue;
        } catch {
          // Half-written config from an interrupted process is still owned by this dead id.
        }
      }
      try {
        fs.rmSync(bridgeDir, { recursive: true, force: true });
        fs.rmSync(path.join(agentRoot, `pi-native-${id}`), { recursive: true, force: true });
        const removeSchema = () => fs.rmSync(path.join(agyDataDir, "mcp", serverName), { recursive: true, force: true });
        if (STABLE_BRIDGE_SERVER_PATTERN.test(serverName)) {
          // A rebuilt live instance may already own the same logical server.
          removeDeadBridgeLease(agentDir, serverName, id, isDeadPid, removeSchema);
        } else {
          removeSchema();
        }
        swept.push(id);
      } catch {
        // Ignore individual removal races across concurrent Pi processes.
      }
    }
  } catch {
    // Best-effort sweep must never disrupt bridge registration.
  }
  return swept;
}
