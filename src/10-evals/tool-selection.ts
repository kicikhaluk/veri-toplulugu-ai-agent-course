import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Same five tools from module 9 — no execution here, we only care whether
// Claude *chooses* the right one and fills it in sensibly. Each case below
// is a single, isolated API call: no loop, no filesystem, no confirmation.
// That's what makes this kind of eval cheap enough to run on every change.
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

type EvalCase = {
  id: string;
  note: string;
  messages: Anthropic.MessageParam[];
  // undefined means "expect no tool call at all — a plain text answer is correct"
  expectedTool?: string;
  checkInput?: (input: Record<string, unknown>) => boolean;
};

const cases: EvalCase[] = [
  {
    id: "list-root",
    note: "a request to see everything should pick list_dir on the workspace root",
    messages: [{ role: "user", content: "What files are in the workspace right now?" }],
    expectedTool: "list_dir",
    checkInput: (input) => input.path === "." || input.path === "./",
  },
  {
    id: "read-specific-file",
    note: "asking about one named file's contents should pick read_file, not list_dir",
    messages: [{ role: "user", content: "What does draft-a.md say under the Root cause heading?" }],
    expectedTool: "read_file",
    checkInput: (input) => input.path === "draft-a.md",
  },
  {
    id: "write-new-file",
    note: "a create-this-file request should pick write_file with the given content",
    messages: [
      { role: "user", content: "Create a file called scratch-notes.txt containing the single line: placeholder" },
    ],
    expectedTool: "write_file",
    checkInput: (input) =>
      input.path === "scratch-notes.txt" &&
      typeof input.content === "string" &&
      input.content.toLowerCase().includes("placeholder"),
  },
  {
    id: "delete-explicit",
    note: "an explicit delete request should pick delete_file, not edit or write_file",
    messages: [{ role: "user", content: "Please delete old-notes.txt, it's no longer needed." }],
    expectedTool: "delete_file",
    checkInput: (input) => input.path === "old-notes.txt",
  },
  {
    id: "merge-with-prior-context",
    // This case primes the conversation with tool_use/tool_result blocks as if
    // both drafts had already been read, the way they'd actually look mid-task.
    // Single-step evals aren't limited to a bare first user turn.
    note: "once both drafts are already in context, 'merge them' should write merged.md with content from both",
    messages: [
      { role: "user", content: "Read draft-a.md and draft-b.md so we can merge them." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading both files now." },
          { type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "draft-a.md" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_a",
            content: "## Root cause\n\nA per-request retry buffer leaked memory on every failed delivery attempt.",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_b", name: "read_file", input: { path: "draft-b.md" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b",
            content: "## Timeline\n\nTue 11:15 — Priya finds the leaking retry buffer. Tue 18:02 — Fix deployed.",
          },
        ],
      },
      { role: "assistant", content: "Got both. Ready to merge whenever you are." },
      { role: "user", content: "Great, merge those into merged.md now." },
    ],
    expectedTool: "write_file",
    checkInput: (input) =>
      input.path === "merged.md" &&
      typeof input.content === "string" &&
      /retry buffer/i.test(input.content) &&
      /(11:15|18:02|timeline)/i.test(input.content),
  },
  {
    id: "no-tool-needed",
    note: "a question that doesn't touch the workspace shouldn't trigger any tool call",
    messages: [{ role: "user", content: "In one sentence, what makes a good incident-retro write-up?" }],
    expectedTool: undefined,
  },
];

async function runCase(testCase: EvalCase): Promise<boolean> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    tools,
    messages: testCase.messages,
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");

  if (testCase.expectedTool === undefined) {
    const pass = toolUse === undefined;
    console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.id} — ${testCase.note}`);
    if (!pass) console.log(`      expected no tool call, got ${toolUse!.name}(${JSON.stringify(toolUse!.input)})`);
    return pass;
  }

  if (toolUse === undefined) {
    console.log(`FAIL  ${testCase.id} — ${testCase.note}`);
    console.log(`      expected ${testCase.expectedTool}, got no tool call — response was text only`);
    return false;
  }

  const toolMatches = toolUse.name === testCase.expectedTool;
  const inputMatches = testCase.checkInput ? testCase.checkInput(toolUse.input as Record<string, unknown>) : true;
  const pass = toolMatches && inputMatches;

  console.log(`${pass ? "PASS" : "FAIL"}  ${testCase.id} — ${testCase.note}`);
  if (!pass) {
    console.log(`      expected ${testCase.expectedTool}, got ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
  }
  return pass;
}

let passed = 0;
for (const testCase of cases) {
  if (await runCase(testCase)) passed++;
}

console.log(`\n${passed}/${cases.length} tool-selection cases passed.`);
if (passed < cases.length) process.exitCode = 1;
