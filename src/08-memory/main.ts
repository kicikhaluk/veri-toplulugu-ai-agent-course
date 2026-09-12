import "dotenv/config";
import * as path from "node:path";
import { mkdir, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Anthropic's memory tool always addresses files under a virtual "/memories"
// root — that string has nothing to do with the real filesystem. Mapping it
// onto a real directory is entirely our job. Unlike every workspace/ this
// course has used so far, this directory is deliberately NOT reset between
// runs: persisting across separate process invocations is the whole point.
const MEMORY_PREFIX = "/memories";
const memoryRoot = path.resolve(import.meta.dirname, "memory");

function resolveMemoryPath(virtualPath: string): string {
  if (virtualPath !== MEMORY_PREFIX && !virtualPath.startsWith(MEMORY_PREFIX + "/")) {
    throw new Error(`"${virtualPath}" must start with ${MEMORY_PREFIX}`);
  }
  const relative = virtualPath === MEMORY_PREFIX ? "." : virtualPath.slice(MEMORY_PREFIX.length + 1);
  const target = path.resolve(memoryRoot, relative);
  if (target !== memoryRoot && !target.startsWith(memoryRoot + path.sep)) {
    throw new Error(`"${virtualPath}" resolves outside ${MEMORY_PREFIX} — refusing.`);
  }
  return target;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

// --- The six memory commands, matching the documented reference behavior ---
// (exact return-string formats and error messages) so that a real Claude
// model — trained on that documented behavior — gets the responses it
// expects.

async function viewPath(virtualPath: string, viewRange?: [number, number]): Promise<string> {
  const target = resolveMemoryPath(virtualPath);
  const stats = await stat(target).catch(() => null);
  if (!stats) {
    throw new Error(`The path ${virtualPath} does not exist. Please provide a valid path.`);
  }

  if (stats.isDirectory()) {
    const lines: string[] = [`4.0K\t${virtualPath}`];
    async function walk(realDir: string, virtualDir: string, depth: number): Promise<void> {
      if (depth > 2) return;
      const entries = await readdir(realDir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const childReal = path.join(realDir, entry.name);
        const childVirtual = `${virtualDir}/${entry.name}`;
        if (entry.isDirectory()) {
          lines.push(`4.0K\t${childVirtual}`);
          await walk(childReal, childVirtual, depth + 1);
        } else {
          const childStats = await stat(childReal);
          lines.push(`${formatBytes(childStats.size)}\t${childVirtual}`);
        }
      }
    }
    await walk(target, virtualPath, 1);
    return `Here're the files and directories up to 2 levels deep in ${virtualPath}, excluding hidden items and node_modules:\n${lines.join("\n")}`;
  }

  const content = await readFile(target, "utf-8");
  const lines = content.split("\n");
  const start = viewRange ? viewRange[0] : 1;
  const end = viewRange ? (viewRange[1] === -1 ? lines.length : viewRange[1]) : lines.length;
  const numbered = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(6, " ")}\t${line}`)
    .join("\n");
  return `Here's the content of ${virtualPath} with line numbers:\n${numbered}`;
}

async function createFile(virtualPath: string, fileText: string): Promise<string> {
  const target = resolveMemoryPath(virtualPath);
  const exists = await stat(target)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(`Error: File ${virtualPath} already exists`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, fileText, "utf-8");
  return `File created successfully at: ${virtualPath}`;
}

async function strReplace(virtualPath: string, oldStr: string, newStr: string | undefined): Promise<string> {
  const target = resolveMemoryPath(virtualPath);
  const stats = await stat(target).catch(() => null);
  if (!stats || stats.isDirectory()) {
    throw new Error(`Error: The path ${virtualPath} does not exist. Please provide a valid path.`);
  }
  const original = await readFile(target, "utf-8");
  const occurrences = original.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${virtualPath}.`);
  }
  if (occurrences > 1) {
    const lineNumbers = original
      .split("\n")
      .map((line, i) => (line.includes(oldStr) ? i + 1 : -1))
      .filter((n) => n !== -1);
    throw new Error(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers.join(", ")}. Please ensure it is unique`,
    );
  }

  const replacement = newStr ?? "";
  const updated = original.replace(oldStr, replacement);
  await writeFile(target, updated, "utf-8");

  const updatedLines = updated.split("\n");
  const editIndex = updated.slice(0, updated.indexOf(replacement)).split("\n").length - 1;
  const from = Math.max(0, editIndex - 2);
  const to = Math.min(updatedLines.length, editIndex + 3);
  const snippet = updatedLines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(6, " ")}\t${line}`)
    .join("\n");
  return `The memory file has been edited.\n${snippet}`;
}

async function insertLine(virtualPath: string, atLine: number, text: string): Promise<string> {
  const target = resolveMemoryPath(virtualPath);
  const original = await readFile(target, "utf-8").catch(() => null);
  if (original === null) {
    throw new Error(`Error: The path ${virtualPath} does not exist`);
  }
  const lines = original.split("\n");
  if (atLine < 0 || atLine > lines.length) {
    throw new Error(
      `Error: Invalid \`insert_line\` parameter: ${atLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    );
  }
  lines.splice(atLine, 0, text.endsWith("\n") ? text.slice(0, -1) : text);
  await writeFile(target, lines.join("\n"), "utf-8");
  return `The file ${virtualPath} has been edited.`;
}

async function deletePath(virtualPath: string): Promise<string> {
  if (virtualPath === MEMORY_PREFIX) {
    throw new Error(`Error: cannot delete the memory root ${MEMORY_PREFIX}`);
  }
  const target = resolveMemoryPath(virtualPath);
  const exists = await stat(target)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`Error: The path ${virtualPath} does not exist`);
  }
  await rm(target, { recursive: true, force: true });
  return `Successfully deleted ${virtualPath}`;
}

async function renamePath(oldVirtualPath: string, newVirtualPath: string): Promise<string> {
  if (oldVirtualPath === MEMORY_PREFIX || newVirtualPath === MEMORY_PREFIX) {
    throw new Error(`Error: cannot rename the memory root ${MEMORY_PREFIX}`);
  }
  const oldTarget = resolveMemoryPath(oldVirtualPath);
  const newTarget = resolveMemoryPath(newVirtualPath);
  const oldExists = await stat(oldTarget)
    .then(() => true)
    .catch(() => false);
  if (!oldExists) {
    throw new Error(`Error: The path ${oldVirtualPath} does not exist`);
  }
  const newExists = await stat(newTarget)
    .then(() => true)
    .catch(() => false);
  if (newExists) {
    throw new Error(`Error: The destination ${newVirtualPath} already exists`);
  }
  await mkdir(path.dirname(newTarget), { recursive: true });
  await fsRename(oldTarget, newTarget);
  return `Successfully renamed ${oldVirtualPath} to ${newVirtualPath}`;
}

async function executeMemory(rawInput: unknown): Promise<{ content: string; isError: boolean }> {
  try {
    const input = rawInput as Record<string, unknown>;
    const command = expectString(input.command, "command");
    switch (command) {
      case "view": {
        const viewPathArg = expectString(input.path, "path");
        const range = Array.isArray(input.view_range) ? (input.view_range as [number, number]) : undefined;
        return { content: await viewPath(viewPathArg, range), isError: false };
      }
      case "create":
        return {
          content: await createFile(expectString(input.path, "path"), expectString(input.file_text, "file_text")),
          isError: false,
        };
      case "str_replace":
        return {
          content: await strReplace(
            expectString(input.path, "path"),
            expectString(input.old_str, "old_str"),
            typeof input.new_str === "string" ? input.new_str : undefined,
          ),
          isError: false,
        };
      case "insert": {
        const atLine = input.insert_line;
        if (typeof atLine !== "number") {
          throw new Error(`Expected "insert_line" to be a number, got ${typeof atLine}`);
        }
        return {
          content: await insertLine(expectString(input.path, "path"), atLine, expectString(input.insert_text, "insert_text")),
          isError: false,
        };
      }
      case "delete":
        return { content: await deletePath(expectString(input.path, "path")), isError: false };
      case "rename":
        return {
          content: await renamePath(expectString(input.old_path, "old_path"), expectString(input.new_path, "new_path")),
          isError: false,
        };
      default:
        return { content: `Error: unknown command "${command}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

// The memory tool is Anthropic-defined and schema-less, like the bash and
// text-editor tools — declare it by type and name only. No system prompt is
// set in this module on purpose: the instruction to check memory first is
// injected by the API automatically whenever this tool is present, and the
// point of this module is to see that happen without writing it ourselves.
const tools: Anthropic.Messages.ToolUnion[] = [{ type: "memory_20250818", name: "memory" }];

function logTurn(response: Anthropic.Message): void {
  console.log(`\n--- turn (stop_reason: ${response.stop_reason}) ---`);
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`text: ${block.text}`);
    } else if (block.type === "tool_use") {
      console.log(`tool_use: ${block.name}(${JSON.stringify(block.input)})`);
    } else {
      console.log(`[unrecognized block type: ${block.type}]`);
      console.dir(block, { depth: null });
    }
  }
  const usage = response.usage;
  console.log(
    `usage: input=${usage.input_tokens} cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} output=${usage.output_tokens}`,
  );
}

function logToolResults(toolResults: Anthropic.ToolResultBlockParam[]): void {
  console.log("tool_result(s):");
  for (const result of toolResults) {
    const text = typeof result.content === "string" ? result.content : "(non-string content)";
    const preview = text.slice(0, 160).replace(/\n/g, " ");
    const ellipsis = text.length > 160 ? "…" : "";
    console.log(`  ${result.tool_use_id} ${result.is_error ? "[error] " : ""}${preview}${ellipsis}`);
  }
}

// --- Main loop -------------------------------------------------------------

const TASKS: Record<string, string> = {
  teach:
    "Remember two facts for future sessions: (1) our on-call escalation policy is to page the secondary " +
    "on-call after 15 minutes of no acknowledgment from the primary; (2) the 'payments' service is owned by " +
    "the Payments team, reachable in Slack at #payments-oncall.",
  recall: "What's our on-call escalation policy, and who owns the payments service?",
};

const mode = process.argv[2];
const task = mode ? TASKS[mode] : undefined;
if (!task) {
  console.error(`Usage: npx tsx 08-memory/main.ts <${Object.keys(TASKS).join("|")}>`);
  process.exit(1);
}

// A fresh /memories on the very first run should list as empty, not error —
// matching the documented behavior for a store that hasn't been written to
// yet. Every later run finds this directory already populated.
await mkdir(memoryRoot, { recursive: true });

const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: task }] }];

while (true) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools,
    messages,
  });

  logTurn(response);
  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason !== "tool_use") break;

  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of toolUseBlocks) {
    const { content, isError } = await executeMemory(block.input);
    toolResults.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
  }

  logToolResults(toolResults);
  messages.push({ role: "user", content: toolResults });
}
