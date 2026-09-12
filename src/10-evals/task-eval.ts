import "dotenv/config";
import * as path from "node:path";
import * as os from "node:os";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// --- Tools + execution, same shape as module 3/9, but the workspace root is
// a fresh temp directory per run instead of a fixed folder — evals need a
// clean, disposable filesystem every time, not the shared demo one.
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

// --- Step 2: feed the dataset through Claude -------------------------------
//
// Same loop shape as every other module, parameterized by the one thing
// we're actually iterating on: the system prompt. No guardrails here —
// evals run unattended, so a maxTurns cap is the safety net that replaces
// a human declining to confirm a runaway loop.
async function runAgentToCompletion(
  root: string,
  task: string,
  systemPrompt: string | undefined,
  maxTurns = 8,
): Promise<void> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: task }] }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(root, block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.content, is_error: result.isError });
    }
    messages.push({ role: "user", content: toolResults });
  }
}

// --- Step 3: two graders -----------------------------------------------
//
// Grader A: code-based. Cheap, deterministic, no model involved — did the
// right files end up in the right state.
type CodeCheck = { name: string; ok: boolean };

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

// Grader B: model-based, for the part that's actually about judgment. The
// system prompt spells out the exact JSON shape we want; a forced tool call
// backs that instruction up so we get a real, always-parseable object back
// instead of hand-parsing JSON the model might not have formatted correctly.
const GRADER_SYSTEM_PROMPT = `You are an impartial grader reviewing a document an AI agent produced for a task.
You will be given the grading rubric for this task, followed by the material to grade.
Respond with a single call to the submit_grade tool, in this shape:
- strengths: an array of 1 to 3 key strengths of the result
- weakness: an array of 1 to 3 key areas for improvement
- reasoning: a concise explanation of your overall assessment
- score: a number from 1 (fails the rubric badly) to 10 (fully meets it)`;

const graderTool: Anthropic.Tool = {
  name: "submit_grade",
  description: "Submit your evaluation of the document against the rubric.",
  input_schema: {
    type: "object",
    properties: {
      strengths: { type: "array", items: { type: "string" }, description: "1 to 3 key strengths" },
      weakness: { type: "array", items: { type: "string" }, description: "1 to 3 key areas for improvement" },
      reasoning: { type: "string", description: "Concise explanation of the overall assessment" },
      score: { type: "integer", description: "1 (fails the rubric badly) to 10 (fully meets it)" },
    },
    required: ["strengths", "weakness", "reasoning", "score"],
  },
};

type ModelGrade = { strengths: string[]; weakness: string[]; reasoning: string; score: number };

async function gradeWithModel(rubric: string, material: string): Promise<ModelGrade> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: GRADER_SYSTEM_PROMPT,
    tools: [graderTool],
    tool_choice: { type: "tool", name: "submit_grade" },
    messages: [{ role: "user", content: `RUBRIC:\n${rubric}\n\n---\n\n${material}` }],
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")!;
  return block.input as ModelGrade;
}

// --- Step 1: the eval dataset -----------------------------------------
//
// Two fixture pairs, two rubrics. Small on purpose — a real dataset grows
// over time as regressions get turned into new cases, the same way a bug
// fix earns a regression test.
type Scenario = {
  id: string;
  fixtureDir: string;
  task: string;
  repeats: number; // how many times to run this scenario per prompt under test
  codeChecks: (root: string) => Promise<CodeCheck[]>;
  rubric: string;
  buildGraderInput: (root: string) => Promise<string>;
};

const MERGE_TASK =
  "Read draft-a.md and draft-b.md in the workspace — they're two people's notes on the same incident retro. " +
  "Merge them into a single merged.md that combines the content without duplicating it. " +
  "Once merged.md looks good, delete draft-a.md and draft-b.md since they're now redundant.";

const scenarios: Scenario[] = [
  {
    id: "standard-merge",
    fixtureDir: path.resolve(import.meta.dirname, "fixtures/standard"),
    task: MERGE_TASK,
    repeats: 1,
    codeChecks: async (root) => {
      const mergedPath = path.join(root, "merged.md");
      const merged = (await fileExists(mergedPath)) ? await readFile(mergedPath, "utf-8") : "";
      return [
        { name: "merged.md exists", ok: merged.length > 0 },
        { name: "draft-a.md deleted", ok: !(await fileExists(path.join(root, "draft-a.md"))) },
        { name: "draft-b.md deleted", ok: !(await fileExists(path.join(root, "draft-b.md"))) },
        { name: "covers root-cause detail from draft-a", ok: /retry buffer/i.test(merged) },
        { name: "covers timeline detail from draft-b", ok: /(11:15|heap snapshot)/i.test(merged) },
      ];
    },
    rubric:
      "The merged document should preserve the substance of both source drafts below without duplicating content.",
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
    repeats: 3, // this is the scenario where behavior varies run to run — repeat it
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
      "or blend them into something neither draft actually said.",
    buildGraderInput: async (root) => {
      const merged = await readFile(path.join(root, "merged.md"), "utf-8").catch(() => "(merged.md was never created)");
      const fixtureA = await readFile(path.resolve(import.meta.dirname, "fixtures/conflict/draft-a.md"), "utf-8");
      const fixtureB = await readFile(path.resolve(import.meta.dirname, "fixtures/conflict/draft-b.md"), "utf-8");
      return `SOURCE DRAFT A:\n${fixtureA}\n\nSOURCE DRAFT B:\n${fixtureB}\n\nMERGED RESULT:\n${merged}`;
    },
  },
];

// --- Step 4: the prompts under test -------------------------------------
//
// Baseline first, so there's something to measure improvement against.
// "No system prompt" is a legitimate baseline — it's exactly what module 9's
// demo ran, and it's what turned up inconsistent conflict handling.
const BASELINE_SYSTEM_PROMPT: string | undefined = undefined;

const CANDIDATE_SYSTEM_PROMPT =
  "You are Wrangler, an agent that merges related documents in a shared workspace. " +
  "When two sources disagree about a material fact — a root cause, an owner, a date — do not silently " +
  'pick one account or blend them into vague, both-could-be-true language. Add an explicit "Disagreement" ' +
  "section naming exactly what each source claims, so a human can resolve it. Only merge silently when " +
  "the sources actually agree.";

type RunResult = { codeAllPassed: boolean; modelGrade: ModelGrade };

async function runOnce(scenario: Scenario, systemPrompt: string | undefined): Promise<RunResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), `wrangler-eval-${scenario.id}-`));
  try {
    await cp(scenario.fixtureDir, root, { recursive: true });
    await runAgentToCompletion(root, scenario.task, systemPrompt);

    const checks = await scenario.codeChecks(root);
    const codeAllPassed = checks.every((c) => c.ok);

    const graderInput = await scenario.buildGraderInput(root);
    const modelGrade = await gradeWithModel(scenario.rubric, graderInput);

    return { codeAllPassed, modelGrade };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runPromptOverDataset(systemPrompt: string | undefined): Promise<Record<string, RunResult[]>> {
  const byScenario: Record<string, RunResult[]> = {};
  for (const scenario of scenarios) {
    const results: RunResult[] = [];
    byScenario[scenario.id] = results;
    for (let i = 0; i < scenario.repeats; i++) {
      const result = await runOnce(scenario, systemPrompt);
      results.push(result);
      console.log(
        `  [${scenario.id}] run ${i + 1}/${scenario.repeats} — code ${result.codeAllPassed ? "PASS" : "FAIL"}` +
          `  model score ${result.modelGrade.score}/10`,
      );
      console.log(`      weakness: ${result.modelGrade.weakness.join("; ")}`);
    }
  }
  return byScenario;
}

function summarize(results: RunResult[]): { avgScore: number; codePassRate: number } {
  return {
    avgScore: results.reduce((sum, r) => sum + r.modelGrade.score, 0) / results.length,
    codePassRate: results.filter((r) => r.codeAllPassed).length / results.length,
  };
}

console.log("=== baseline: no system prompt ===");
const baselineResults = await runPromptOverDataset(BASELINE_SYSTEM_PROMPT);

console.log("\n=== candidate: explicit disagreement instruction ===");
const candidateResults = await runPromptOverDataset(CANDIDATE_SYSTEM_PROMPT);

console.log("\n=== summary: baseline vs candidate ===");
for (const scenario of scenarios) {
  const baseline = summarize(baselineResults[scenario.id]!);
  const candidate = summarize(candidateResults[scenario.id]!);
  console.log(`${scenario.id}:`);
  console.log(`  baseline  — avg model score ${baseline.avgScore.toFixed(1)}/10, code pass rate ${(baseline.codePassRate * 100).toFixed(0)}%`);
  console.log(`  candidate — avg model score ${candidate.avgScore.toFixed(1)}/10, code pass rate ${(candidate.codePassRate * 100).toFixed(0)}%`);
}
