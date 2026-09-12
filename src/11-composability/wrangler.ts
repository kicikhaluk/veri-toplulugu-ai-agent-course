import "dotenv/config";
import * as path from "node:path";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Same sandbox-guard pattern as module 3, but scoped to whatever root the
// caller passes in — a fixed workspace was fine for a demo script; a reusable
// Wrangler has to work against any directory it's pointed at.
function makeResolver(root: string) {
  return (relativePath: string): string => {
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`"${relativePath}" resolves outside the workspace root — refusing.`);
    }
    return target;
  };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}

export const tools: Anthropic.Tool[] = [
  {
    name: "list_dir",
    description: "List the files and directories at a path inside the workspace. Use \".\" for the workspace root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory to list, relative to the workspace root." } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full text contents of a file inside the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File to read, relative to the workspace root." } },
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
      "Replace one exact occurrence of old_str with new_str in an existing file. old_str must match exactly and must be unique in the file.",
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
  {
    name: "delete_file",
    description: "Permanently delete a file inside the workspace. This cannot be undone.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File to delete, relative to the workspace root." } },
      required: ["path"],
    },
  },
];

export async function executeTool(
  root: string,
  name: string,
  rawInput: unknown,
): Promise<{ content: string; isError: boolean }> {
  const resolveSafePath = makeResolver(root);
  const input = rawInput as Record<string, unknown>;
  try {
    switch (name) {
      case "list_dir": {
        const target = resolveSafePath(expectString(input.path, "path"));
        const entries = await readdir(target, { withFileTypes: true });
        const content =
          entries.length === 0
            ? "(empty directory)"
            : entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`).join("\n");
        return { content, isError: false };
      }
      case "read_file": {
        const target = resolveSafePath(expectString(input.path, "path"));
        return { content: await readFile(target, "utf-8"), isError: false };
      }
      case "write_file": {
        const relPath = expectString(input.path, "path");
        const content = expectString(input.content, "content");
        const target = resolveSafePath(relPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf-8");
        return { content: `Wrote ${content.length} bytes to ${relPath}`, isError: false };
      }
      case "edit": {
        const relPath = expectString(input.path, "path");
        const oldStr = expectString(input.old_str, "old_str");
        const newStr = expectString(input.new_str, "new_str");
        const target = resolveSafePath(relPath);
        const original = await readFile(target, "utf-8");
        const occurrences = original.split(oldStr).length - 1;
        if (occurrences === 0) throw new Error(`old_str not found in ${relPath}`);
        if (occurrences > 1) {
          throw new Error(`old_str matches ${occurrences} times in ${relPath} — it must be unique.`);
        }
        await writeFile(target, original.replace(oldStr, newStr), "utf-8");
        return { content: `Replaced 1 occurrence in ${relPath}`, isError: false };
      }
      case "delete_file": {
        const relPath = expectString(input.path, "path");
        await rm(resolveSafePath(relPath));
        return { content: `Deleted ${relPath}`, isError: false };
      }
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export type WranglerOptions = {
  systemPrompt?: string;
  maxTurns?: number;
  // Fires after every model turn — how the CLI prints progress and how the
  // subagent demo distinguishes a nested run's turns from the parent's own.
  onTurn?: (response: Anthropic.Message) => void;
};

export type WranglerResult = { finalText: string; turns: number };

// The one Wrangler loop, extracted so a CLI and a parent agent can both call
// it as a plain function instead of each owning their own copy of the loop.
export async function runWrangler(root: string, task: string, options: WranglerOptions = {}): Promise<WranglerResult> {
  const { systemPrompt, maxTurns = 8, onTurn } = options;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: task }] }];
  let lastText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      tools,
      messages,
    });
    onTurn?.(response);
    messages.push({ role: "assistant", content: response.content });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (textBlock) lastText = textBlock.text;
    if (response.stop_reason !== "tool_use") return { finalText: lastText, turns: turn + 1 };

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(root, block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { finalText: lastText || "(stopped: reached max turns without a final text answer)", turns: maxTurns };
}
