import "dotenv/config";
import * as path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);
const client = new Anthropic();

// Same guard as Modules 3-4, reused by every client-executed tool below.
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

// Client-executed tools (name/description/input_schema, no "type") sit
// alongside Anthropic-defined server tools (a version-suffixed "type", no
// input_schema) in the same array. ToolUnion is the type that covers both —
// annotating as Anthropic.Tool[] (Module 3-4's annotation) would reject the
// server tool entries below, since Tool is only the custom-tool shape.
const tools: Anthropic.Messages.ToolUnion[] = [
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
  {
    name: "search",
    description:
      "Search for a regular expression across text files in the workspace, recursively. Returns each match as \"path:line: text\".",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A JavaScript regular expression, without slashes (e.g. \"TODO\")." },
        path: { type: "string", description: "Directory to search within, relative to the workspace root. Defaults to the workspace root." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a read-only command from a fixed allowlist (ls, cat, wc, head, tail, pwd, git) inside the workspace. Pass the command and its arguments separately — never a shell string with pipes or redirects, since none of that is interpreted.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The executable name, e.g. \"wc\"." },
        args: { type: "array", items: { type: "string" }, description: "Arguments, e.g. [\"-l\", \"src/util.ts\"]." },
      },
      required: ["command", "args"],
    },
  },
  // Below this line: Anthropic-hosted server tools. No input_schema, no
  // executeTool case — Anthropic runs these on its own infrastructure and
  // the result comes back already resolved, as extra content blocks in the
  // same response rather than something we execute and report on.
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "code_execution_20260120", name: "code_execution" },
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

const MAX_SEARCH_MATCHES = 100;

async function searchTool(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const pattern = expectString(input.pattern, "pattern");
  const relDir = typeof input.path === "string" ? input.path : ".";
  const searchRoot = resolveSafePath(relDir);
  const regex = new RegExp(pattern);

  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        let content: string;
        try {
          content = await readFile(full, "utf-8");
        } catch {
          continue; // skip unreadable/binary files
        }
        const relToRoot = path.relative(workspaceRoot, full);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          const line = lines[i];
          if (line !== undefined && regex.test(line)) {
            matches.push(`${relToRoot}:${i + 1}: ${line}`);
          }
        }
      }
    }
  }

  await walk(searchRoot);
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}

const ALLOWED_COMMANDS = new Set(["ls", "cat", "wc", "head", "tail", "pwd", "git"]);

function assertArgsConfined(args: string[]): void {
  for (const arg of args) {
    if (arg.startsWith("-")) continue; // a flag, not a path
    resolveSafePath(arg);
  }
}

async function runCommand(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const command = expectString(input.command, "command");
  const argsRaw = input.args;
  if (!Array.isArray(argsRaw) || !argsRaw.every((a) => typeof a === "string")) {
    throw new Error('Expected "args" to be an array of strings');
  }
  const args = argsRaw as string[];

  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`"${command}" is not in the allowlist (${[...ALLOWED_COMMANDS].join(", ")})`);
  }
  assertArgsConfined(args);

  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: workspaceRoot,
    timeout: 5000,
  });
  return stdout || stderr || "(no output)";
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
      case "search":
        return { content: await searchTool(input), isError: false };
      case "run_command":
        return { content: await runCommand(input), isError: false };
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

const messages: Anthropic.MessageParam[] = [
  {
    role: "user",
    content:
      "Read data.csv from the workspace. Use code execution to compute the mean and standard deviation of the " +
      "\"value\" column. Then use web search to find the year Anthropic first released the original Claude model. " +
      "Finally, write both results as a short summary to summary.md in the workspace.",
  },
];

while (true) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools,
    messages,
  });

  console.log("\n=== response ===");
  console.dir(response, { depth: null });

  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason === "pause_turn") {
    // The server-side tool loop (web search / code execution) hit its
    // iteration cap mid-turn. Nothing for us to execute — just re-send so
    // Anthropic resumes where it left off. The API reads the trailing
    // server_tool_use block to know this is a resume, not a new ask.
    continue;
  }

  if (response.stop_reason !== "tool_use") {
    break;
  }

  // Only client-executed calls show up as "tool_use" blocks. Server tools
  // (web_search, code_execution) run and resolve entirely on Anthropic's
  // side — their calls and results appear as other block types
  // (server_tool_use, web_search_tool_result, ...) already inside
  // response.content, with nothing for executeTool() to do.
  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
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
