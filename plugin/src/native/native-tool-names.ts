import { createHash } from "node:crypto";

/** CLI ids include the server even though MCP tools/list only returns the local name. */
export function bridgeToolName(serverName: string, toolName: string, toolPrefix = ""): string {
  const original = `${toolPrefix}${toolName}`;
  const budget = 64 - `mcp_${serverName}_`.length;
  let name = original;
  if (name.length > budget) {
    // Keep a readable stem, but hash the FULL name so equal stems cannot alias.
    const suffix = `_${createHash("sha256").update(original).digest("hex").slice(0, 24)}`;
    if (budget <= suffix.length) {
      throw new Error(`Antigravity CLI server name leaves no room for tool "${toolName}".`);
    }
    name = `${original.slice(0, budget - suffix.length)}${suffix}`;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(`mcp_${serverName}_${name}`)) {
    throw new Error(`Invalid Antigravity CLI name for Pi tool "${toolName}": ${name}`);
  }
  return name;
}

/** Reject any alias collision (including a literal Pi name equal to an alias), never misroute. */
export function bridgeToolNames(
  serverName: string,
  toolNames: readonly string[],
  toolPrefix = "",
): Map<string, string> {
  const names = new Map<string, string>();
  for (const tool of toolNames) {
    const name = bridgeToolName(serverName, tool, toolPrefix);
    const existing = names.get(name);
    if (existing !== undefined && existing !== tool) {
      throw new Error(`Antigravity bridge tool name collision: "${tool}" and "${existing}" -> ${name}`);
    }
    names.set(name, tool);
  }
  return names;
}
