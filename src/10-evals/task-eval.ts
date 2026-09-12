import "dotenv/config";
import * as path from "node:path";
import * as os from "node:os";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// --- Tools + execution, same shape as module 3/9, but the workspace root is
// a fresh temp directory per scenario run instead of a fixed folder — evals
// need a clean, disposable filesystem each time, not the shared demo one.
function makeResolver(root: string) {
  return function resolveSafePath(relativePath: string): string {
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
    name: "delete_file",
    description: "Permanently delete a file inside the workspace. This cannot be undone.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File to delete, relative to the workspace root." } },
      required: ["path"],
    },
  },
];

async function executeTool(root: string, name: string, rawInput: unknown): Promise<{ content: string; isError: boolean }> {
  const resolveSafePath = makeResolver(root);
  const input = rawInput as Record<string, unknown>;
  try {
    switch (name) {
      case "list_dir": {
        const target = resolveSafePath(expectString(input.path, "path"));
        const entries = await readdir(target, { withFileTypes: true });
        const content = entries.length
          ? entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`).join("\n")
          : "(empty directory)";
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

// No guardrails here on purpose — evals need to run unattended, with nobody
// at a keyboard to type "y". A max-turn cap is the safety net that replaces
// human confirmation: an agent that never converges fails the eval instead
// of looping forever.
async function runAgentToCompletion(root: string, task: string, maxTurns = 8): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: task }] }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const finalText = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      return finalText?.text ?? "(no final text)";
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(root, block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return "(hit max turn cap without the model stopping — treating as incomplete)";
}

// --- Grading ---------------------------------------------------------------
//
// Two kinds of checks, deliberately kept separate:
//   - code checks: cheap, deterministic, no model involved (did the right
//     files end up in the right state?)
//   - a grader call: for the part that's actually about judgment (is this
//     *good*?), forced through a tool so the score comes back structured
//     instead of parsed out of prose.

const graderTool: Anthropic.Tool = {
  name: "submit_grade",
  description: "Submit your evaluation of the document against the rubric.",
  input_schema: {
    type: "object",
    properties: {
      score: { type: "integer", description: "1 (fails the rubric) to 5 (fully meets it)" },
      passed: { type: "boolean", description: "true only if the document clearly meets the bar in the rubric" },
      reasoning: { type: "string", description: "One or two sentences explaining the score." },
    },
    required: ["score", "passed", "reasoning"],
  },
};

async function grade(rubric: string, material: string): Promise<{ score: number; passed: boolean; reasoning: string }> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    tools: [graderTool],
    tool_choice: { type: "tool", name: "submit_grade" },
    messages: [{ role: "user", content: `${rubric}\n\n---\n\n${material}` }],
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")!;
  return block.input as { score: number; passed: boolean; reasoning: string };
}

type CodeCheck = { name: string; ok: boolean; detail?: string };

type Scenario = {
  id: string;
  fixtureDir: string;
  task: string;
  codeChecks: (root: string) => Promise<CodeCheck[]>;
  rubric: string;
  buildGraderInput: (root: string) => Promise<string>;
};

const MERGE_TASK =
  "Read draft-a.md and draft-b.md in the workspace — they're two people's notes on the same incident retro. " +
  "Merge them into a single merged.md that combines the content without duplicating it. " +
  "Once merged.md looks good, delete draft-a.md and draft-b.md since they're now redundant.";

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

const scenarios: Scenario[] = [
  {
    id: "standard-merge",
    fixtureDir: path.resolve(import.meta.dirname, "fixtures/standard"),
    task: MERGE_TASK,
    codeChecks: async (root) => {
      const mergedPath = path.join(root, "merged.md");
      const merged = (await fileExists(mergedPath)) ? await readFile(mergedPath, "utf-8") : "";
      return [
        { name: "merged.md exists", ok: merged.length > 0 },
        { name: "draft-a.md deleted", ok: !(await fileExists(path.join(root, "draft-a.md"))) },
        { name: "draft-b.md deleted", ok: !(await fileExists(path.join(root, "draft-b.md"))) },
        {
          name: "covers root-cause detail from draft-a",
          ok: /retry buffer/i.test(merged),
        },
        {
          name: "covers timeline detail from draft-b",
          ok: /(11:15|heap snapshot)/i.test(merged),
        },
      ];
    },
    rubric:
      "You are grading a merged incident-retro document against two source drafts it was built from. " +
      "Score 1-5 on whether the merge preserves the substance of both drafts without duplicating content. " +
      "passed should be true only if score >= 4.",
    buildGraderInput: async (root) => {
      const merged = await readFile(path.join(root, "merged.md"), "utf-8").catch(() => "(merged.md was never created)");
      const fixtureA = await readFile(path.resolve(import.meta.dirname, "fixtures/standard/draft-a.md"), "utf-8");
      const fixtureB = await readFile(path.resolve(import.meta.dirname, "fixtures/standard/draft-b.md"), "utf-8");
      return `SOURCE DRAFT A:\n${fixtureA}\n\nSOURCE DRAFT B:\n${fixtureB}\n\nMERGED RESULT:\n${merged}`;
    },
  },
  {
    id: "conflicting-root-cause",
    fixtureDir: path.resolve(import.meta.dirname, "fixtures/conflict"),
    task: MERGE_TASK,
    codeChecks: async (root) => {
      const mergedPath = path.join(root, "merged.md");
      const merged = (await fileExists(mergedPath)) ? await readFile(mergedPath, "utf-8") : "";
      return [
        { name: "merged.md exists", ok: merged.length > 0 },
        { name: "draft-a.md deleted", ok: !(await fileExists(path.join(root, "draft-a.md"))) },
        { name: "draft-b.md deleted", ok: !(await fileExists(path.join(root, "draft-b.md"))) },
      ];
    },
    rubric:
      "The two source drafts below disagree about the root cause of the same incident — one blames connection-pool " +
      "exhaustion, the other blames an unbounded retry backoff against a degraded upstream. A good merge must " +
      "surface this disagreement explicitly so a human can resolve it, not silently pick one account as the truth " +
      "or blend them into something neither draft actually said. Score 1-5 on whether the merged document does " +
      "this. passed should be true only if the disagreement is explicitly and clearly called out.",
    buildGraderInput: async (root) => {
      const merged = await readFile(path.join(root, "merged.md"), "utf-8").catch(() => "(merged.md was never created)");
      const fixtureA = await readFile(path.resolve(import.meta.dirname, "fixtures/conflict/draft-a.md"), "utf-8");
      const fixtureB = await readFile(path.resolve(import.meta.dirname, "fixtures/conflict/draft-b.md"), "utf-8");
      return `SOURCE DRAFT A:\n${fixtureA}\n\nSOURCE DRAFT B:\n${fixtureB}\n\nMERGED RESULT:\n${merged}`;
    },
  },
];

async function runScenario(scenario: Scenario): Promise<boolean> {
  console.log(`\n=== scenario: ${scenario.id} ===`);
  const root = await mkdtemp(path.join(os.tmpdir(), `wrangler-eval-${scenario.id}-`));
  try {
    await cp(scenario.fixtureDir, root, { recursive: true });
    await runAgentToCompletion(root, scenario.task);

    const checks = await scenario.codeChecks(root);
    for (const check of checks) {
      console.log(`  [code check] ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    const codeChecksPassed = checks.every((c) => c.ok);

    const graderInput = await scenario.buildGraderInput(root);
    const verdict = await grade(scenario.rubric, graderInput);
    console.log(`  [grader]     score=${verdict.score}/5  passed=${verdict.passed}`);
    console.log(`  [grader]     ${verdict.reasoning}`);

    return codeChecksPassed && verdict.passed;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let passed = 0;
for (const scenario of scenarios) {
  if (await runScenario(scenario)) passed++;
}

console.log(`\n${passed}/${scenarios.length} scenarios passed.`);
if (passed < scenarios.length) process.exitCode = 1;
