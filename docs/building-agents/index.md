---
layout: default
title: Building an Agent from Scratch with Claude
permalink: /building-agents/
---

Building an agent from scratch with Claude: the agentic loop, evals, and tool use — no framework, just the Claude API and TypeScript.

By the end of this course you'll have **Wrangler**, a general-purpose local agent that lives in a scoped workspace directory and can read/write/grep files, run shell commands behind an approval gate, search the web, execute code, and hand off browser-shaped tasks. Every module adds one capability to the same agent — nothing here is a toy example you throw away.

All code lives in `src/` in this repository, one numbered folder per module, sharing a single `npm` project.

## Requirements

- Node.js 20+ (the examples were written against Node 24)
- An Anthropic API key, kept in a `.env` file — never commit it. Copy the template and fill in your key:

  ```bash
  cd src
  cp .env.example .env
  # then edit src/.env and set ANTHROPIC_API_KEY=sk-ant-...
  ```

  `src/.env` is already covered by the repository's `.gitignore`.

## Module 0 — Setup and the core primitives

Every agent, no matter how sophisticated, is built from five primitives:

- **Model** — the thing that reasons and decides. Claude, reached through a single API endpoint (`POST /v1/messages`).
- **Tools** — named, schema-described actions the model can request. The model never executes anything itself; it emits a request, your code executes it.
- **History** — the list of messages (user turns, assistant turns, tool calls, tool results) that gets resent on every request. The API is stateless — the *conversation* is a value you own, not something the server remembers for you.
- **Memory** — state that outlives a single conversation (as opposed to history, which lives only within one). We'll get here in Module 8.
- **Orchestration** — the loop: send messages, inspect the response, run any requested tools, feed results back, decide whether to stop. This loop is the actual "agent" — everything else is plumbing around it.

This course builds the orchestration loop by hand first, so you can see exactly what a framework would otherwise hide from you.

### Project setup

From the repository root:

```bash
cd src
npm init -y
npm install @anthropic-ai/sdk dotenv
npm install -D typescript tsx @types/node
```

- `@anthropic-ai/sdk` — the official Anthropic TypeScript SDK. We call the Messages API through it directly; no agent framework.
- `dotenv` — loads `ANTHROPIC_API_KEY` (and later, other config) from a local `.env` file into `process.env`, so you never type a key into your shell history or hardcode it in source.
- `typescript` + `@types/node` — type checking.
- `tsx` — runs `.ts` files directly, no separate build step, which keeps each module a single runnable file.

Set `"type": "module"` in `src/package.json` (we'll write ESM throughout) and add a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`strict` and `noUncheckedIndexedAccess` matter more than usual here: tool inputs arrive as `unknown` JSON from the model, and a loose compiler will happily let you ship a bug where you trust that JSON's shape without checking it.

## Module 1 — Your first call to Claude

Before any loop, before any tools, make one request and read the response. This is `src/01-first-call/main.ts`:

```typescript
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY, loaded from .env by dotenv/config

const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  system: "You are a terse assistant. Answer in one sentence.",
  messages: [{ role: "user", content: "What is an AI agent, in plain terms?" }],
});

for (const block of response.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
}
```

Run it:

```bash
cd src
npx tsx 01-first-call/main.ts
```

**Why Haiku 4.5, not a bigger model?** Every module in this course makes several requests while you iterate — this is a course about the *loop*, not about squeezing maximum reasoning out of one call. Claude Haiku 4.5 is fast and inexpensive, so you can re-run examples freely without worrying about cost. Everything we build is model-agnostic: once Wrangler is done, swap `model: "claude-haiku-4-5"` for `model: "claude-opus-5"` anywhere you want more capable reasoning (tool selection on ambiguous tasks, longer agentic runs) at a higher cost per token.

A few things worth noticing before we move on, because they explain the shape of everything that follows:

- **`response.content` is an array of typed blocks, not a string.** A single response can mix text, tool calls, and (later) thinking blocks. You always narrow by `block.type` before reading a field — this is what makes the same response shape work whether Claude is just talking or asking to use a tool.
- **`messages` is an array you constructed, not a session handle.** There's no `client.startConversation()`. The "conversation" is just this array, and if you want a second turn, *you* append to it and send the whole thing again. That's the detail the rest of this course is really about.
- **`system` is separate from `messages`.** It's your standing instruction to the model, not part of the turn-by-turn history.

Try changing the user message and re-running — notice there's no state carried over between runs. Next module, we make that history persistent across turns and add the first tool, which turns this one-shot call into the beginning of an actual agent loop.

## Module 2 — The loop, v0

This is the module that matters most. Everything from here on — filesystem access, web search, guardrails, evals — plugs into the exact loop you write in this section. Nothing about the loop itself changes later; only what's inside it grows.

### Anatomy of a tool

A tool is a name, a description, and a JSON Schema for its input. Claude never executes anything — it only ever emits a *request* to call a tool, as a `tool_use` content block. Your code decides whether, and how, to honor it.

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: "calculate",
    description:
      "Evaluate a single arithmetic operation between two numbers. Call this for any arithmetic you need an exact answer for — never compute it yourself.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          description: "The operation to perform.",
        },
        a: { type: "number", description: "The first operand." },
        b: { type: "number", description: "The second operand." },
      },
      required: ["operation", "a", "b"],
    },
  },
];
```

The `description` is doing more work than it looks like. Claude decides *whether* to call a tool almost entirely from this text, so it's worth being explicit about *when* to call it ("never compute it yourself"), not just what it does — vague descriptions are the single most common reason a model skips a tool it should have used.

### The stopping signal: `stop_reason`

Every response carries a `stop_reason`. The two you'll see constantly:

| `stop_reason` | Meaning | What you do |
| --- | --- | --- |
| `tool_use` | Claude emitted at least one `tool_use` block and wants the result before continuing | Execute the tool(s), send results back, loop again |
| `end_turn` | Claude is done — no pending tool calls | Print the final text and stop |

(There are others — `max_tokens`, `pause_turn`, `refusal` — that matter once we bring in longer runs and server-side tools. We'll handle those as they come up.)

### The loop

```typescript
const messages: Anthropic.MessageParam[] = [
  {
    role: "user",
    content:
      "A workshop has 14 tables. Eleven of them seat 6 people each, and the remaining 3 seat only 4 people each. How many people can the workshop seat in total?",
  },
];

while (true) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools,
    messages,
  });

  // Dump the raw response so you can see the actual shape the API returns —
  // id, model, stop_reason, usage, and the content block array — not just
  // the parts we bother to summarize.
  console.log("\n=== response ===");
  console.dir(response, { depth: null });

  // Always append the FULL response.content, not just the text — the
  // tool_use blocks inside it are what let the next tool_result line up.
  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason !== "tool_use") {
    break;
  }

  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of toolUseBlocks) {
    const result = await executeTool(block.name, block.input);
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: result,
    });
  }

  // And the other half of the round trip: exactly what we send back.
  console.log("\n=== tool_result(s) sent back ===");
  console.dir(toolResults, { depth: null });

  // All tool_result blocks go back in a single user message.
  messages.push({ role: "user", content: toolResults });
}
```

`executeTool` is the dispatcher — a `switch` on tool name that calls the matching function and returns a string:

```typescript
function calculate(input: { operation: string; a: number; b: number }): string {
  const { operation, a, b } = input;
  switch (operation) {
    case "add":
      return String(a + b);
    case "subtract":
      return String(a - b);
    case "multiply":
      return String(a * b);
    case "divide":
      return b === 0 ? "Error: division by zero" : String(a / b);
    default:
      return `Error: unknown operation "${operation}"`;
  }
}

async function executeTool(name: string, input: unknown): Promise<string> {
  switch (name) {
    case "calculate":
      return calculate(input as { operation: string; a: number; b: number });
    default:
      return `Error: no such tool "${name}"`;
  }
}
```

Note `input: unknown` — the model's `tool_use.input` is arbitrary JSON as far as TypeScript is concerned. We cast it here for brevity; from Module 3 onward, where tool inputs choose *which file gets touched*, we validate the shape before trusting it instead of casting blind.

This is `src/02-loop-v0/main.ts` in full. Run it:

```bash
cd src
npx tsx 02-loop-v0/main.ts
```

We're deliberately printing the *raw* `response` object (`console.dir(response, { depth: null })`) rather than a curated summary — reading the actual shape the API hands you is worth more, this early, than a tidy log line. First iteration, unedited (yours may batch the two multiplications differently):

```
=== response ===
{
  model: 'claude-haiku-4-5-20251001',
  id: 'msg_011CexM83ma3axXbhUwASpGJ',
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: 'I need to calculate the total seating capacity of the workshop.'
    },
    {
      type: 'tool_use',
      id: 'toolu_01HvkhVJapntMq7n7bVXTiaT',
      name: 'calculate',
      input: { operation: 'multiply', a: 11, b: 6 },
      caller: { type: 'direct' }
    },
    {
      type: 'tool_use',
      id: 'toolu_017HMgBzNxFmV21Cf1pXitpU',
      name: 'calculate',
      input: { operation: 'multiply', a: 3, b: 4 },
      caller: { type: 'direct' }
    }
  ],
  container: null,
  stop_reason: 'tool_use',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 690,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 167,
    service_tier: 'standard'
  }
}

=== tool_result(s) sent back ===
[
  { type: 'tool_result', tool_use_id: 'toolu_01HvkhVJapntMq7n7bVXTiaT', content: '66' },
  { type: 'tool_result', tool_use_id: 'toolu_017HMgBzNxFmV21Cf1pXitpU', content: '12' }
]
```

...then a second `response`/`tool_result` pair for the `add`, then a final `response` with `stop_reason: 'end_turn'` and no `tool_use` blocks at all — just the closing text. Run it yourself to see all three in full; there's more signal in scrolling through the real thing once than in any amount of prose here.

Five things worth reading out of that structure directly, since you can now see them instead of taking them on faith:

- **`content` is an array, and one `tool_use` block sits next to a `text` block.** Claude explained itself ("I need to calculate...") *and* called the tool in the same turn — text and tool calls are siblings in the same array, not alternatives.
- **Claude called the tool twice in one turn.** Both multiplications arrived as two `tool_use` blocks in a *single* response — this is parallel tool use, on by default. Both results went back in one `user` message with two `tool_result` blocks, not two separate messages. Splitting them across messages is a common bug that silently trains the model to stop batching calls.
- **Every `tool_use` block carries its own `id`, and the matching `tool_result` echoes it as `tool_use_id`.** That's the only thing linking a result to the call that requested it — nothing about ordering or position is load-bearing, the `id` is.
- **`usage` is per-request, not cumulative**, and it grows each turn (690 → 918 → 1026 input tokens) because the *entire* history — including the tool calls and results you just saw — gets resent every time. This is the first concrete look at why Module 7 (context management) exists: an unbounded loop has unboundedly growing input cost.
- **The loop ran three round trips**, not one: multiply × 2 → add → final answer. This is why it's a `while (true)`, not an `if`. A tool-using turn is not the end of the conversation; it's Claude asking for information before it can finish the conversation. `messages` ends up six entries long — your question, three assistant turns, and two `tool_result` replies — and every entry stays in the array, resent in full, for the life of the loop.

Everything else in this course is this same shape: a `while` loop, a `tools` array, a dispatcher. Module 3 replaces the toy calculator with filesystem tools that touch real files on disk — which is also where "trust the model's input" stops being good enough.

## Module 3 — Filesystem tools and a sandbox guard

The loop from Module 2 doesn't change at all here. What changes is what's inside the `tools` array and the `executeTool` dispatcher — and, for the first time, a tool input that names a path is something you have to actively defend against, not just cast and trust.

`calculate` could never do damage: worst case it returns the wrong number. A `read_file`/`write_file` tool can be asked — by an adversarial prompt, or just a confused user typing a bad relative path — to touch a file well outside where you meant to let the agent operate. So Module 3 introduces the pattern every filesystem tool in this course uses from here on: **confine every path to a workspace root, and resolve every model-supplied path through one guard function before it ever reaches `fs`.**

### The sandbox root and the guard

```typescript
import * as path from "node:path";

// Everything the model touches is confined to this directory. No tool below
// ever uses a path the model gives us without resolving it through
// resolveSafePath() first.
const workspaceRoot = path.resolve(import.meta.dirname, "workspace");

function resolveSafePath(relativePath: string): string {
  const target = path.resolve(workspaceRoot, relativePath);
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`"${relativePath}" resolves outside the workspace root — refusing.`);
  }
  return target;
}
```

`import.meta.dirname` is the ESM replacement for the `__dirname` you don't have in a `"type": "module"` project — it's the directory of the current file, available without any `fileURLToPath` boilerplate.

The guard itself is the whole trick: resolve the model's path *against* the root with `path.resolve`, then check the result still starts with the root. `path.resolve("workspace", "../secrets.txt")` doesn't stay inside `workspace` — that's exactly the case the `startsWith` check catches. Every one of the four tools below calls `resolveSafePath` before touching disk; none of them do their own path math.

### Real input validation, not a cast

Module 2 cast `tool_use.input` straight to the shape it expected and left it there as a deferred problem. Now that a bad shape can mean writing to the wrong file, that cast is replaced with an actual runtime check:

```typescript
function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}
```

Every tool function reads its fields through `expectString` (or a sibling you'd write for other types) instead of destructuring and hoping. It's a small function, but it's the difference between "the model sent a malformed `tool_use.input`" failing loudly, right at the boundary, versus failing confusingly three lines into a filesystem call.

### Four tools, one dispatcher, errors reported — not thrown

```typescript
const tools: Anthropic.Tool[] = [
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
];
```

`edit` is deliberately modeled on the find-and-replace tool Claude Code itself uses: `old_str` must match exactly once. That uniqueness requirement isn't pedantry — it's what makes an edit safe to apply without the model (or you) re-reading the whole file to confirm which occurrence it meant.

The tool implementations (`list_dir`, `read_file`, `write_file`, `edit`) are unsurprising once you've seen the guard — each pulls its path through `resolveSafePath`, does one `node:fs/promises` call, and returns a string. `edit` is the only one with real logic: count occurrences of `old_str` with `original.split(oldStr).length - 1`, and refuse to proceed unless that count is exactly 1.

What's new is the dispatcher. Filesystem calls fail for mundane reasons — a missing file, a guard rejection, a non-unique `old_str` — and those failures are information the model can act on, not a reason to crash the loop:

```typescript
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
```

And the one change to the loop itself — `tool_result` blocks carry a real `is_error` field in the API, and now we set it:

```typescript
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
```

`is_error: true` doesn't stop the loop or throw on your side — it's a signal *to Claude* that this particular result is a failure, so it can read the message and decide what to do next (try a different path, ask you, give up gracefully) instead of misreading an error string as a normal result.

This is `src/03-filesystem/main.ts` in full, working against a small sandbox at `src/03-filesystem/workspace/` (a `notes.txt` and a `todo.md` are seeded there for the demo). Run it:

```bash
cd src
npx tsx 03-filesystem/main.ts
```

### Watching the guard actually trip

The demo prompt asks the agent to list the workspace, read `notes.txt`, edit `todo.md`, and then — "just to see what happens" — read `../secrets.txt`, a file that sits one level *above* the workspace root (and exists, so a block here is provably the guard, not a missing-file error). Real output, trimmed to the interesting parts:

```
=== response ===   (first turn: list_dir + read_file, run in parallel)
content: [
  { type: 'text', text: "I'll help you with that. Let me start by listing the workspace contents and reading notes.txt." },
  { type: 'tool_use', name: 'list_dir', input: { path: '.' }, ... },
  { type: 'tool_use', name: 'read_file', input: { path: 'notes.txt' }, ... }
]
stop_reason: 'tool_use'
```

...a second round trip reads `todo.md` to find the right insertion point, then the third round trip is the one worth reading in full:

```
=== response ===
content: [
  { type: 'text', text: 'Perfect! Now I'll add the new line after "- Write filesystem tools" and then try to read ../secrets.txt.' },
  {
    type: 'tool_use',
    name: 'edit',
    input: {
      path: 'todo.md',
      old_str: '- Set up the loop\n- Write filesystem tools',
      new_str: '- Set up the loop\n- Write filesystem tools\n- Ship module 3'
    }
  },
  { type: 'tool_use', name: 'read_file', input: { path: '../secrets.txt' } }
]
stop_reason: 'tool_use'

=== tool_result(s) sent back ===
[
  { type: 'tool_result', tool_use_id: '...', content: 'Replaced 1 occurrence in todo.md', is_error: false },
  {
    type: 'tool_result',
    tool_use_id: '...',
    content: '"../secrets.txt" resolves outside the workspace root — refusing.',
    is_error: true
  }
]
```

Claude batched the edit and the boundary-crossing read into the same turn — it had no way to know one would fail. The guard did exactly its job: `read_file` never touched `fs` for that path at all, `resolveSafePath` threw first, and the error came back as a normal `tool_result` with `is_error: true`. The final turn (`stop_reason: 'end_turn'`) has Claude reporting the refusal back to you in plain language, unprompted, because that's what a failed tool call sitting in its context looks like from the model's side. Run it yourself to see the exact IDs and the full first exchange.

Four things worth carrying forward from this module:

- **The guard lives in exactly one function.** Every tool routes through `resolveSafePath` — there's one place to audit, not four. When Module 4 adds a `bash` tool with real command execution, this is the pattern that gets reused, not reinvented.
- **A rejected path is not an exception you let crash the loop.** It's a `tool_result` with `is_error: true`, same shape as a successful one, sent back so the model can react to it in-conversation.
- **Runtime input validation stopped being optional.** `expectString` is trivial, but it's the boundary where "arbitrary JSON from the model" becomes "a string you can safely hand to `path.resolve`."
- **The model didn't need to be told not to try `../secrets.txt` — it tried anyway, because you told it to ("just to see what happens").** In a real agent, that curiosity doesn't announce itself as a test; it shows up as an ordinary-looking path that happens to walk out of bounds. The guard has to hold regardless of whether the model's intent was adversarial or completely innocent.

Module 4 keeps the same guard and the same `is_error` pattern, and adds the tools that make an agent feel genuinely useful on a real project: a search/grep tool, and a `bash` tool gated behind an allowlist — which is also where parallel tool use stops being a curiosity and starts being something you have to actively think about.

## Module 4 — Search, a gated bash tool, and orchestration in practice

Wrangler now has four filesystem tools, carried over unchanged from Module 3. This module adds two more — `search` and `run_command` — and, more importantly, is where you start noticing that "the loop" and "the tools" aren't really separate concerns: how the model orchestrates several tools across several turns depends entirely on what your tool descriptions and results tell it.

### `search`: a purpose-built tool

`run_command` could technically do a text search — `grep -r` is right there. But a narrow, purpose-built tool that returns structured, capped output is worth writing separately whenever a task is common enough to deserve it: it's safe by construction (no shell, no argument-escaping to worry about), and its output is shaped for the model to consume directly, rather than free-form terminal text it has to parse.

```typescript
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
```

Two details worth noticing: `resolveSafePath` still runs, once, on the *starting* directory the model supplied — everything `walk` discovers after that comes from `readdir`, not from the model, so it can't be used to escape the sandbox. And `MAX_SEARCH_MATCHES` caps the result — an unbounded match list on a big enough workspace would blow past the context you have to spend on it, which is the same `usage`-growth concern Module 2 flagged, just arriving from a different direction.

### `run_command`: a generic escape valve, gated twice

Sometimes there's no purpose-built tool for what's needed, and writing one for every possible command isn't realistic. `run_command` is the fallback — but a fallback that runs arbitrary shell input is a fallback that undoes every guard you've built so far, so it's restricted in two independent ways.

**First gate — no shell at all.** The tool takes a `command` string and an `args` array as *separate* fields, and executes them with `execFile`, not `exec`. `execFile` never hands the string to `/bin/sh`, so there's no shell to inject into — a value like `"; rm -rf /"` in an argument is just a literal argument, not a command separator, because no shell ever parses it.

```typescript
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
```

**Second gate — the same path guard, applied to arguments.** Restricting *which binary* runs isn't enough: `cat` is harmless in the abstract, but `cat ../../../etc/passwd` isn't, and an allowlist that only checks the command name would wave it straight through. `assertArgsConfined` runs every non-flag argument through `resolveSafePath` — the exact function `read_file` and `edit` already use — before `execFile` ever starts the process. Reusing it here instead of writing a second path check is the point: one guard, audited once, trusted everywhere it's needed.

Worth being honest about the limits, too: skipping arguments that start with `-` is a heuristic, not a parser — something like `--file=../secret` would slip past it uncaught, since it doesn't start with a bare path. Good enough to teach the idea inside a sandboxed demo; not something to ship as your only defense on a tool that shells out for real. `timeout: 5000` is the other quiet addition — a hung subprocess shouldn't be able to hang your agent, a concern that'll come back properly in Module 9's guardrails.

### Running it: six tools, and a loop that stops parallelizing when it should

This is `src/04-search-and-bash/main.ts` in full, working against `src/04-search-and-bash/workspace/` — a tiny two-file fake project with a few `TODO` comments seeded in, plus a file one level above the sandbox root to test the guard against. Run it:

```bash
cd src
npx tsx 04-search-and-bash/main.ts
```

The prompt asks for a chain of dependent steps: search for `TODO`s, find the file with the most, count its lines, read it for context, then try to `cat` a file outside the sandbox. Real output, trimmed to the tool calls:

```
turn 1 — search({ pattern: 'TODO', path: '.' })
  → "src/index.ts:2: ...\nsrc/util.ts:2: ...\nsrc/util.ts:3: ..."

turn 2 — run_command({ command: 'wc', args: ['-l', 'src/util.ts'] })
  → "       5 src/util.ts\n"

turn 3 — read_file({ path: 'src/util.ts' })
  → "export function formatName(first: string, last: string): string {\n  // TODO: ...\n..."

turn 4 — run_command({ command: 'cat', args: ['../secret-outside.txt'] })
  → is_error: true — '"../secret-outside.txt" resolves outside the workspace root — refusing.'

turn 5 — stop_reason: 'end_turn', Claude summarizes all four steps, guard test included
```

Notice what *didn't* happen: every one of those tool calls arrived **alone**, one per turn, across five separate round trips — not batched, even though Module 2's arithmetic example batched two `calculate` calls into a single turn without being asked to. The model isn't choosing to be slow; each step here genuinely depends on the result of the last one (you can't count lines in "whichever file has the most TODOs" until you've seen the search results, and you can't decide the guard test matters until the rest is done). Parallel tool use is something Claude does when calls are independent, not something you request — which means the shape of your prompt, and how contingent each step is on the one before it, drives how much of your agent's latency comes from serialized round trips versus batched ones. That's the "orchestration in practice" this module's title promises: you don't control the batching directly, but you can see it happening, and you can design tools and prompts so the independent parts of a task actually are independent.

Three things worth carrying forward:

- **Purpose-built and generic tools solve different problems, and a mature toolset has both.** `search` is safe by construction with structured output; `run_command` covers everything you didn't anticipate, at the cost of needing its own, more careful guarding.
- **`execFile`, not `exec`.** Passing `command` and `args` as separate fields — never a single shell string — means there's no shell for an injected argument to reach. This is a design choice in the tool's input schema, not just an implementation detail: the schema itself is what stops the model from ever having the *option* to hand you `"cat file; rm -rf ."` as one string.
- **Reuse guards instead of re-deriving them.** `assertArgsConfined` isn't a new security mechanism — it's `resolveSafePath`, called from a second place. Every new tool that touches paths should be asking "can I route this through the guard I already have," not writing a fresh one.

Every tool so far has run under your direct authority — Wrangler does exactly what you told it it's allowed to do, the moment it's told. Module 5 introduces tools Anthropic hosts and runs *for* you (web search, code execution) rather than ones your process executes, which changes what "the loop" has to account for — including a new `stop_reason` you haven't seen yet.

## Module 5 — Server tools: web search and code execution

Every tool up to this point has followed the same shape: Claude asks, your process runs something, you report a result back. That's true of `read_file`, and it's true of `run_command` — even though `run_command` shells out to a real subprocess, *your* process still owns that subprocess, decides whether it's allowed to run, and reports the outcome.

Anthropic also hosts a handful of tools that skip that middle step entirely. `web_search` and `code_execution` run on Anthropic's own infrastructure — you don't spawn anything, you don't guard a path, you don't get a `tool_use` block asking you to act. You just declare the tool, and results show up already resolved inside the response. That's a genuinely different kind of tool, and it changes two things about the loop: what `tools` can contain, and what a single response can mean.

### Declaring a server tool

A client tool is `{ name, description, input_schema }`. A server tool is a version-suffixed `type` and a `name` — no schema, because you're not the one producing the input:

```typescript
const tools: Anthropic.Messages.ToolUnion[] = [
  // ...list_dir, read_file, write_file, edit, search, run_command from Module 4, unchanged...
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "code_execution_20260120", name: "code_execution" },
];
```

Two things worth noticing before the code even runs. First, the type annotation changed: Modules 3 and 4 declared `tools: Anthropic.Tool[]`, but `Tool` is specifically the *custom*-tool shape — it has no `type` field for `"web_search_20250305"` to occupy. `Anthropic.Messages.ToolUnion` is the type that covers both custom tools and Anthropic-defined ones, so mixing the two kinds in one array means widening the annotation, not narrowing it.

Second, `web_search_20250305` — not the newer `web_search_20260209`. The 2026 version adds *dynamic filtering* (Claude writes and runs code to filter search results before they reach the context window), but that capability is currently scoped to Opus and Sonnet-tier models; Haiku 4.5, which this course has used throughout, stays on the older, simpler tool version. Same idea applies if you swap models later — check what a given `_2026...` tool version actually supports on the model you're pointing it at, rather than assuming the newest suffix is always the right one.

### Mixing client and server tools in one loop

The dispatcher (`executeTool`, the `switch` over tool names) doesn't change at all — and that's the point worth sitting with. Look at how the loop decides what needs a `tool_result`:

```typescript
const toolUseBlocks = response.content.filter(
  (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
);
```

A client tool call arrives as a `tool_use` block, same as every module so far. A server tool call arrives as a `server_tool_use` block, and its result as its own block type (`web_search_tool_result`, `bash_code_execution_tool_result`) — both already sitting in `response.content` by the time you see it. They're different TypeScript types (`ToolUseBlock` vs. `ServerToolUseBlock`), so the existing filter already excludes server-tool activity without any change. Nothing to execute, nothing to report — Anthropic did that part before the response ever reached you.

The one real addition is a new `stop_reason`:

```typescript
if (response.stop_reason === "pause_turn") {
  // The server-side tool loop (web search / code execution) hit its
  // iteration cap mid-turn. Nothing for us to execute — just re-send so
  // Anthropic resumes where it left off.
  continue;
}
```

Server tools run their own internal loop — Claude can call `web_search` or `code_execution` several times in a row, server-side, chasing one answer. If that internal loop hits its default cap of 10 iterations before it's done, the response comes back with `stop_reason: "pause_turn"` instead of `"tool_use"` or `"end_turn"`. There's no tool result to send; you just push the assistant turn back onto `messages` and ask again — the API reads the trailing `server_tool_use` block and resumes automatically. Skip this check and a paused turn looks exactly like a finished one: the loop breaks, you get a truncated answer, and nothing tells you it happened.

### Running it

```
cd src
npx tsx 05-server-tools/main.ts
```

The prompt chains a client read, a server computation, a server search, and a client write: read `data.csv`, compute mean and standard deviation with `code_execution`, look up the year Claude first launched with `web_search`, then `write_file` a summary. Real output, trimmed to what each turn did:

```
turn 1 — read_file({ path: 'data.csv' })
  → "label,value\nrun_1,14.2\n...\n"

turn 2 — server_tool_use: bash_code_execution
  runs a small Python script (csv + statistics) against the file it already has from context
  → bash_code_execution_tool_result: mean and stdev printed to stdout

turn 3 — server_tool_use: web_search
  → web_search_tool_result: 10 web_search_result entries (Wikipedia's "Claude (language model)" among them)

turn 4 — write_file({ path: 'summary.md', content: '# Summary of Results\n\n## Data Analysis\n- Mean: 15.325\n- Standard Deviation: 1.066\n\n## Claude Model Release\n...' })
  → "Wrote 444 bytes to summary.md"

turn 5 — read_file({ path: 'summary.md' })   (Claude double-checking its own write)
  → file contents echoed back

turn 6 — stop_reason: 'end_turn'
  final answer, with a real citation block: { type: 'web_search_result_location', url: 'https://en.wikipedia.org/wiki/Claude_(language_model)', cited_text: '...March 2023...' }
```

The mean (15.325) and standard deviation (1.066) are exactly right for the eight values in `data.csv` — that arithmetic happened in a real Python interpreter on Anthropic's infrastructure, not in Claude's own token generation. The citation on the final answer is real too: a URL, a title, and the exact cited span, attached because `web_search` results carry citation metadata by default. One small, honest wrinkle: the draft `summary.md` Claude wrote in turn 4 has a stray malformed `(cite index="4-3">...</cite>` fragment in it — a bit of its own citation markup that leaked into plain file content instead of staying in the response text. Nothing broke, but it's a good reminder for later: text a model writes into a file is still model output, not sanitized data, and Module 9's guardrails are exactly where "should this write have gone through unreviewed" gets a real answer.

`pause_turn` didn't fire in this run — six turns is well under the server-side cap of 10 — so the `continue` branch above is genuinely untested by this particular transcript. That's fine, and it's the honest way to present it: you don't get to choose when a real API demo happens to exercise every branch, but you can still reason about *why* the branch has to exist and write it correctly ahead of needing it, the same way Module 4's `run_command` timeout was written before anything actually hung.

Three things worth carrying forward:

- **Not every tool is something you execute.** `web_search` and `code_execution` are declared, not implemented — no `input_schema`, no case in `executeTool`. The dispatcher's job is to handle the tools that need handling, not to have an opinion about the ones that don't.
- **Content block *type* is what tells client tools and server tools apart, not which array they came from.** `tools` holds both kinds side by side; `response.content` is where they diverge — `tool_use` for you, `server_tool_use`/`*_tool_result` for Anthropic, already resolved.
- **A `stop_reason` you don't check is a failure mode you can't see.** `pause_turn` looks like nothing went wrong — no error, no `is_error`, just a shorter answer than the task warranted. The only defense is checking for it explicitly, the same discipline as checking `is_error` on a tool result.

Every module so far has had Wrangler act entirely on its own machine, or on Anthropic's — but "outside systems" so far has meant a fixed allowlist you wrote by hand (`ALLOWED_COMMANDS` in Module 4) or a web search Anthropic runs for you. Module 6 asks a different question: what happens when you want Wrangler to talk to a *specific* external system — a database, an internal API, another team's tool server — that neither of those covers.
