import "dotenv/config";
import * as path from "node:path";
import { mkdir, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Same workspace-confinement pattern as module 3 — nothing below ever
// touches a path the model gives us without resolving it through this first.
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

// --- Risk tiers --------------------------------------------------------
//
// Every tool the model can call gets a tier. The tier decides what has to
// happen *before* the tool actually runs — nothing about the tool
// implementations below changes.
//
//   auto         read-only, no side effects: run immediately
//   confirm      mutates the workspace, but recoverably: ask a human first
//   irreversible destructive and hard to undo: ask a human to type a literal
//                confirmation phrase, not just y/n
//
// A tool with no entry here is treated as "irreversible" — unrecognized
// tools fail closed, not open.
type RiskTier = "auto" | "confirm" | "irreversible";

const RISK_TIER: Record<string, RiskTier> = {
  list_dir: "auto",
  read_file: "auto",
  write_file: "confirm",
  edit: "confirm",
  delete_file: "irreversible",
};

const tools: Anthropic.Tool[] = [
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

async function listDir(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const target = resolveSafePath(expectString(input.path, "path"));
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length === 0) return "(empty directory)";
  return entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`).join("\n");
}

async function readFileTool(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const target = resolveSafePath(expectString(input.path, "path"));
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
  if (occurrences === 0) throw new Error(`old_str not found in ${relPath}`);
  if (occurrences > 1) {
    throw new Error(`old_str matches ${occurrences} times in ${relPath} — it must be unique.`);
  }
  await writeFile(target, original.replace(oldStr, newStr), "utf-8");
  return `Replaced 1 occurrence in ${relPath}`;
}

async function deleteFileTool(rawInput: unknown): Promise<string> {
  const input = rawInput as Record<string, unknown>;
  const relPath = expectString(input.path, "path");
  const target = resolveSafePath(relPath);
  await rm(target);
  return `Deleted ${relPath}`;
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
      case "delete_file":
        return { content: await deleteFileTool(input), isError: false };
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

// --- Guardrails: dry-run, human confirmation, audit log -----------------

const dryRun = process.argv.includes("--dry-run");
const rl = readline.createInterface({ input: stdin, output: stdout });

async function confirmYesNo(promptText: string): Promise<boolean> {
  const answer = (await rl.question(promptText)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function confirmPhrase(promptText: string, expected: string): Promise<boolean> {
  const answer = (await rl.question(promptText)).trim();
  return answer === expected;
}

function describeCall(name: string, input: unknown): string {
  return `${name}(${JSON.stringify(input)})`;
}

const auditLogPath = path.resolve(import.meta.dirname, "audit.log.jsonl");

async function appendAudit(entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(auditLogPath, line + "\n", "utf-8");
}

// Every tool call passes through here, never through executeTool() directly.
// The audit log is written host-side, by this function — it is not a tool
// the model can call, so nothing the model does can edit its own record.
async function runGuarded(
  name: string,
  rawInput: unknown,
  toolUseId: string,
): Promise<{ content: string; isError: boolean }> {
  const tier = RISK_TIER[name] ?? "irreversible";
  const call = describeCall(name, rawInput);
  const startedAt = Date.now();

  if (tier !== "auto" && dryRun) {
    console.log(`[dry-run] would run ${call} (tier: ${tier}) — skipping, no changes made.`);
    await appendAudit({ tool: name, toolUseId, input: rawInput, tier, decision: "dry-run", ok: true, durationMs: 0 });
    return { content: `[dry-run] ${call} was not actually executed.`, isError: false };
  }

  if (tier === "confirm") {
    const approved = await confirmYesNo(`\n[confirm] Claude wants to run ${call}\nAllow? (y/N) `);
    if (!approved) {
      console.log(`[denied] ${call}`);
      await appendAudit({ tool: name, toolUseId, input: rawInput, tier, decision: "denied", ok: false, durationMs: Date.now() - startedAt });
      return { content: `Denied by operator: ${name} was not executed.`, isError: true };
    }
  }

  if (tier === "irreversible") {
    const approved = await confirmPhrase(
      `\n[irreversible] Claude wants to run ${call}\nThis cannot be undone. Type DELETE to allow: `,
      "DELETE",
    );
    if (!approved) {
      console.log(`[denied] ${call}`);
      await appendAudit({ tool: name, toolUseId, input: rawInput, tier, decision: "denied", ok: false, durationMs: Date.now() - startedAt });
      return { content: `Denied by operator: ${name} was not executed.`, isError: true };
    }
  }

  const result = await executeTool(name, rawInput);
  await appendAudit({
    tool: name,
    toolUseId,
    input: rawInput,
    tier,
    decision: tier === "auto" ? "auto" : "approved",
    ok: !result.isError,
    resultPreview: result.content.slice(0, 200),
    durationMs: Date.now() - startedAt,
  });
  return result;
}

function logTurn(response: Anthropic.Message): void {
  console.log(`\n--- turn (stop_reason: ${response.stop_reason}) ---`);
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`text: ${block.text}`);
    } else if (block.type === "tool_use") {
      console.log(`tool_use: ${block.name}(${JSON.stringify(block.input)}) [tier: ${RISK_TIER[block.name] ?? "irreversible"}]`);
    } else {
      console.log(`[unrecognized block type: ${block.type}]`);
      console.dir(block, { depth: null });
    }
  }
  const usage = response.usage;
  console.log(`usage: input=${usage.input_tokens} output=${usage.output_tokens}`);
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

// --- Main loop ------------------------------------------------------------

const TASK =
  "Read draft-a.md and draft-b.md in the workspace — they're two people's notes on the same incident retro. " +
  "Merge them into a single merged.md that combines the timeline and the follow-ups without duplicating content. " +
  "Once merged.md looks good, delete draft-a.md and draft-b.md since they're now redundant.";

const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: TASK }] }];

if (dryRun) console.log("Running in --dry-run mode: confirm/irreversible tools will be reported, not executed.\n");

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
    const { content, isError } = await runGuarded(block.name, block.input, block.id);
    toolResults.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
  }

  logToolResults(toolResults);
  messages.push({ role: "user", content: toolResults });
}

rl.close();
