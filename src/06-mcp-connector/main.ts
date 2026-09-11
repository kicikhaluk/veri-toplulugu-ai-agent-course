import "dotenv/config";
import * as path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Same guard as Modules 3-5.
const workspaceRoot = path.resolve(import.meta.dirname, "workspace");

function resolveSafePath(relativePath: string): string {
  const target = path.resolve(workspaceRoot, relativePath);
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`"${relativePath}" resolves outside the workspace root — refusing.`);
  }
  return target;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}

// This module isolates the new mechanism, so it carries forward just the
// four core filesystem tools from Module 3 — not Module 4's search /
// run_command. Any of Wrangler's client tools could sit alongside an MCP
// toolset the same way these do; there's nothing search-and-bash-specific
// about mixing in a remote server.
const tools: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "list_dir",
    description: "List the files and directories at a path inside the workspace. Use \".\" for the workspace root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full text contents of a file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to read, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file inside the workspace, or overwrite it if it already exists. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to write, relative to the workspace root." },
        content: { type: "string", description: "The full contents to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace one exact occurrence of old_str with new_str in an existing file. old_str must match exactly, including whitespace, and must be unique in the file — include enough surrounding context to make it so.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit, relative to the workspace root." },
        old_str: { type: "string", description: "Exact text to find. Must occur exactly once in the file." },
        new_str: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  // The MCP toolset doesn't list individual tools here — the server does
  // that, at connect time. "deepwiki" below must match a name in
  // mcp_servers.
  { type: "mcp_toolset", mcp_server_name: "deepwiki" },
];

async function listDir(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const relPath = expectString(input.path, "path");
  const target = resolveSafePath(relPath);
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length === 0) return "(empty directory)";
  return entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`).join("\n");
}

async function readFileTool(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const relPath = expectString(input.path, "path");
  const target = resolveSafePath(relPath);
  return await readFile(target, "utf-8");
}

async function writeFileTool(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const relPath = expectString(input.path, "path");
  const content = expectString(input.content, "content");
  const target = resolveSafePath(relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
  return `Wrote ${content.length} bytes to ${relPath}`;
}

async function editFile(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const relPath = expectString(input.path, "path");
  const oldStr = expectString(input.old_str, "old_str");
  const newStr = expectString(input.new_str, "new_str");
  const target = resolveSafePath(relPath);

  const original = await readFile(target, "utf-8");
  const occurrences = original.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_str not found in ${relPath}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `old_str matches ${occurrences} times in ${relPath} — it must be unique. Include more surrounding context.`,
    );
  }

  await writeFile(target, original.replace(oldStr, newStr), "utf-8");
  return `Replaced 1 occurrence in ${relPath}`;
}

async function executeTool(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  try {
    switch (name) {
      case "list_dir":
        return { content: await listDir(input), isError: false };
      case "read_file":
        return { content: await readFileTool(input), isError: false };
      case "write_file":
        return { content: await writeFileTool(input), isError: false };
      case "edit":
        return { content: await editFile(input), isError: false };
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

const messages: Anthropic.Beta.BetaMessageParam[] = [
  {
    role: "user",
    content:
      "Read research-notes.md from the workspace. Then use the deepwiki tool to find out what testing " +
      "framework the anthropics/anthropic-sdk-typescript repository uses. Append the answer to research-notes.md " +
      "under a new \"## Findings\" heading.",
  },
];

while (true) {
  const response = await client.beta.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    betas: ["mcp-client-2025-11-20"],
    mcp_servers: [{ type: "url", url: "https://mcp.deepwiki.com/mcp", name: "deepwiki" }],
    tools,
    messages,
  });

  console.log("\n=== response ===");
  console.dir(response, { depth: null });

  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason !== "tool_use") {
    break;
  }

  // Same principle as Module 5's server tools: an MCP call shows up as its
  // own block type ("mcp_tool_use"), already resolved by the time it
  // reaches us. Only "tool_use" — our four client tools — needs executeTool.
  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const block of toolUseBlocks) {
    const { content, isError } = await executeTool(block.name, block.input);
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content,
      is_error: isError,
    });
  }

  console.log("\n=== tool_result(s) sent back ===");
  console.dir(toolResults, { depth: null });

  messages.push({ role: "user", content: toolResults });
}
