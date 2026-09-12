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

## Module 6 — Wiring in outside systems: the MCP connector

MCP (the Model Context Protocol) is an open standard for exposing a set of tools over HTTP, so that any client speaking the protocol can call them without custom integration code per server. Normally, using an MCP server means running an MCP *client* yourself — a piece of your process that speaks the protocol, connects to the server, lists its tools, and forwards calls. The **MCP connector** is a beta Anthropic feature that skips that middle layer entirely: you tell the Messages API a server URL and a name, and Anthropic connects to it, lists its tools, and lets Claude call them — server-side, the same way `web_search` and `code_execution` were server-side in Module 5.

This module connects Wrangler to a real, public MCP server: [DeepWiki](https://mcp.deepwiki.com/mcp), which answers questions about public GitHub repositories and requires no authentication — a genuine external system, not a mock.

### Two parameters, and a beta header

```typescript
const response = await client.beta.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  betas: ["mcp-client-2025-11-20"],
  mcp_servers: [{ type: "url", url: "https://mcp.deepwiki.com/mcp", name: "deepwiki" }],
  tools,
  messages,
});
```

`mcp_servers` names the connection; `tools` must include a matching entry so Claude knows which tools from that server to expose:

```typescript
{ type: "mcp_toolset", mcp_server_name: "deepwiki" }
```

That's the whole configuration. Unlike every tool this course has written by hand, an `mcp_toolset` has no `input_schema` of its own — the server defines its tools, and the connector discovers them at request time. (`mcp_toolset` also takes optional `default_config` / `configs` fields for allowlisting or denylisting individual tools by name once you know what a server exposes — worth reaching for on a server with write or destructive tools, so Claude only ever sees the read-only ones. DeepWiki is read-only already, so this module doesn't need it.)

### A parallel set of types, because this is `client.beta`

Everything up to this point called `client.messages.create`. The MCP connector is beta, which means calling it goes through `client.beta.messages.create` instead — and that's not a cosmetic difference. The beta surface has its own content block types, its own message param type, its own tool union: `Anthropic.Beta.BetaMessageParam`, `Anthropic.Beta.BetaToolUnion`, `Anthropic.Beta.BetaToolUseBlock`, `Anthropic.Beta.BetaToolResultBlockParam` — parallel to, but not interchangeable with, the `Anthropic.MessageParam` / `Anthropic.Messages.ToolUnion` / `Anthropic.ToolUseBlock` / `Anthropic.ToolResultBlockParam` every prior module used. A `BetaMessage`'s `content` is `BetaContentBlock[]`, not `ContentBlock[]`; mixing the two — say, passing a non-beta `tool_result` into a beta message — is a type error, not a runtime surprise. The four filesystem tools carried forward from Module 3 don't need any code changes to work here (`BetaTool` and `Tool` are structurally identical), but the *types wrapping them* all had to switch to their `Beta`-prefixed counterparts, everywhere this module's `main.ts` touches a message or a tool.

### Running it

```
cd src
npx tsx 06-mcp-connector/main.ts
```

The prompt asks Wrangler to read a local file, answer a question by querying DeepWiki, and write the answer back:

```
turn 1 — read_file({ path: 'research-notes.md' })          [client tool_use]
       — mcp_tool_use: deepwiki.ask_question({
           repoName: 'anthropics/anthropic-sdk-typescript',
           question: 'What testing framework does this repository use?'
         })                                                  [server-side, same turn]

turn 2 — mcp_tool_result: "...primarily uses Jest... jest.config.ts... ts-jest..." (real answer, from a real repo)
       — edit({ path: 'research-notes.md', old_str: '# Research Notes\n...', new_str: '...## Findings\n\nThe anthropics/anthropic-sdk-typescript repository primarily uses **Jest**...' })   [client tool_use]

turn 3 — stop_reason: 'end_turn'
       final answer, summarizing what was read, queried, and written
```

Notice turn 1: `read_file` and the DeepWiki call arrived in the *same* response, side by side — batched, not serialized. That's Module 4's orchestration lesson showing up again from a new angle. Reading a local file and asking a question about a GitHub repository don't depend on each other, so Claude issued both at once — one resolved by your `executeTool` dispatcher, one resolved entirely on Anthropic's servers by the time the response reached you. Independence drives batching regardless of *where* a tool runs; Module 4 showed it for two local tools, Module 5 showed a dependent chain mixing local and Anthropic-hosted tools, and this run shows a local tool and a remote MCP tool batching together because nothing tied them to each other.

The `mcp_tool_use` / `mcp_tool_result` block types are the same story as `server_tool_use` in Module 5, one layer further out: they're their own distinct types, so the existing `block.type === "tool_use"` filter already ignores them without any change. Nothing in `executeTool` knows or needs to know that `deepwiki` exists — the dispatcher's job stayed exactly what it was.

### The browser-handoff pattern (design, not demo)

DeepWiki needed no `authorization_token` — that's why this module could run against it live. Most real MCP servers you'd actually want to wire in (a team's internal Jira, a company database) sit behind OAuth, and `mcp_servers` supports that directly:

```typescript
{ type: "url", url: "https://mcp.example.com/sse", name: "jira", authorization_token: "..." }
```

The token has to come from somewhere, and the honest answer is: not from Wrangler. An agent has no business running an interactive OAuth flow — no browser to redirect, no way to click "Allow" on a consent screen. The correct pattern is a **handoff**: when a tool result signals that authorization is missing (an `mcp_tool_result` with `is_error: true` and content describing an auth failure, or simply no token configured yet for that server), the agent stops, tells the human what it needs and why, and hands them a URL to complete in their own browser — after which the resulting token gets stored (an environment variable, a config file Wrangler reads on startup) and the same request just works on retry. This course's own [MCP inspector aside](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector#authentication) in Anthropic's docs is a manual version of exactly that flow: run a tool, authorize in a browser, paste the resulting token back in.

This is deliberately presented as a pattern rather than a demo: DeepWiki doesn't require auth, so this course has no OAuth-gated server to test the handoff against live, and this book's standing rule is not to claim a run happened when it didn't. The shape is still worth internalizing now, because it's the same shape Module 9 will formalize for *any* action Wrangler shouldn't take unilaterally — asking a human, waiting for an explicit answer, then proceeding.

Three things worth carrying forward:

- **A remote tool server is a `tools` entry, not a new code path.** `mcp_toolset` slots into the same array as `list_dir` and `web_search` — the loop, the dispatcher, and the batching behavior don't change because a tool happens to live on someone else's server.
- **Beta features bring beta types, and they don't mix with the stable ones.** `client.beta.messages.create` isn't just a different method name — every type touching that call (`BetaMessageParam`, `BetaToolUnion`, `BetaToolUseBlock`, `BetaToolResultBlockParam`) has to come from the same beta surface, consistently, or TypeScript will catch the mismatch before you ever hit send.
- **Independence, not location, drives batching.** Whether a tool runs in your process, on Anthropic's infrastructure, or on a third party's MCP server three network hops away, Claude batches it with anything else in the same turn precisely when the two don't depend on each other — never because of where either one happens to execute.

Every tool through Module 6 has done its work and reported back in the same request-response cycle Wrangler was already built around. That cycle has a cost nobody's had to think about yet: every module in this course has grown the transcript, and `messages` has never once been trimmed. Module 7 is where that stops being free — prompt caching, summarizing old tool results, and compaction, all in service of a `messages` array that can outlive its own context window.

## Module 7 — Context management: caching, trimming, and compaction

Every request Wrangler has made so far re-sends the entire conversation from scratch. The tool definitions, the system prompt (once it has one), every prior turn — all of it gets re-processed as fresh input tokens on every single call, even though most of it is byte-for-byte identical to the request before. Three mechanisms address three different parts of that problem: **prompt caching** pays once for content that doesn't change instead of every turn, **trimming old tool results** shrinks the parts of the transcript that were only ever useful in the moment, and **compaction** deals with the transcript itself once it's grown too large to keep around in full. This module adds all three to a fresh copy of Module 3's four filesystem tools, plus one new tool the trimming mechanism needs.

### Prompt caching: paying once for what doesn't change

A cache breakpoint is a marker — `cache_control: { type: "ephemeral" }` — on a content block, telling the API "everything up to and including this block is worth storing for reuse." The next request with an identical prefix up to that point reads it back at roughly a tenth of the normal input price instead of paying full price again. Render order is `tools` → `system` → `messages`, so a marker on the last system block caches the tools and the system prompt together in one entry:

```typescript
const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 2048,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools,
  messages,
});
```

Wrangler didn't have a system prompt before this module — the four filesystem tools' descriptions did all the instructing. This module gives it one: a real operating manual (workspace boundary, tool reference, communication style, error handling, common task patterns, an FAQ) — the kind of thing a production agent actually accumulates, not a paragraph invented to have something to cache.

That "real length" turned out to matter for a very concrete reason. The minimum prefix length before a cache marker does anything at all is model-dependent, and it is **not** the same number you'd guess from other models — Claude Haiku 4.5 needs **4096 tokens**, several times higher than the 512–1024 tokens most other current models need. The first draft of this module's system prompt was a reasonable, tasteful length — and came in under that bar. Nothing errored. The tools+system prefix was 3317 tokens, and the very first live run showed exactly what the docs warn about:

```
usage: input=3317 cache_write=0 cache_read=0 output=152
```

`cache_write: 0` on a request that carries a `cache_control` marker isn't a bug report — it's silence. No error, no warning, just a cache entry that was never written because the prefix didn't clear the minimum. The fix was to write the manual at the length a real one would actually be — the "Common task patterns" and "Frequently asked questions" sections in [`07-context-management/main.ts`](../../src/07-context-management/main.ts) exist as much to clear 4096 tokens honestly as to be useful, and they're genuinely both. After that, the same first request read:

```
usage: input=3 cache_write=399 cache_read=4180 output=162
```

4180 tokens of tools+system, cached. (`cache_read` shows up on turn one here because this exact prefix had already been written seconds earlier, during the previous test run, and the default 5-minute TTL was still live — a preview of exactly the reuse this mechanism is for.)

### A second breakpoint for the growing tail, and a gotcha it exposed

One marker on the system prompt caches the part that never changes. The conversation itself grows every turn, so it needs its own, moving marker — the "multi-turn conversations" pattern: put a breakpoint on the last content block of the most recently appended message, and move it forward each turn rather than leaving old ones stacked up (the API allows at most 4 breakpoints per request, so accumulating one per turn would eventually hit that ceiling):

```typescript
function moveMessageBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block === "object" && "cache_control" in block) {
        delete block.cache_control;
      }
    }
  }
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const lastBlock = last.content[last.content.length - 1];
  if (typeof lastBlock === "object") {
    (lastBlock as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = { type: "ephemeral" };
  }
}
```

Writing this exposed a second, unrelated gotcha: `cache_control` lives on a content *block*, not on a message. Wrangler's very first user message was written the way every prior module wrote one — `{ role: "user", content: TASK }`, a plain string — and a plain string has no block to attach a marker to. `moveMessageBreakpoint`'s `Array.isArray(last.content)` check quietly returned early for it, every time, and that message's tokens never got cached at all. The fix was mechanical once found: construct it as a one-block array instead —

```typescript
let messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: TASK }] }];
```

— and the same fix applies to the message compaction produces further down. Nothing about this raised an error at any point; it just meant fewer tokens were ever eligible for a cache hit than intended. It's the same shape of lesson as Module 5's leaked citation fragment and Module 6's beta-type mismatch: the API does exactly what you told it, and "what you told it" is worth checking against real `usage` numbers, not just against what compiles.

### Summarizing old tool results, with a way back

A tool result is often only useful for the one or two turns immediately after it arrives — once Wrangler has read a file and acted on it, the raw bytes rarely matter again. Keeping every one in full forever means paying to re-process file contents the model has already used and moved on from, on every subsequent turn. `trimOldToolResults` keeps only the most recent tool-result-bearing turn in full and collapses anything older to a short placeholder:

```typescript
const KEEP_RECENT_TOOL_TURNS = 1;

function trimOldToolResults(messages: Anthropic.MessageParam[]): void {
  const toolResultTurnIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => typeof block === "object" && block.type === "tool_result"),
    )
    .map(({ index }) => index);

  const trimmableIndices = toolResultTurnIndices.slice(
    0,
    Math.max(0, toolResultTurnIndices.length - KEEP_RECENT_TOOL_TURNS),
  );

  for (const index of trimmableIndices) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block.type !== "tool_result") continue;
      if (typeof block.content !== "string") continue;
      if (block.content.startsWith("[trimmed:")) continue;
      const original = block.content;
      block.content = `[trimmed: ${original.length} chars omitted — call recall_tool_result({ tool_use_id: "${block.tool_use_id}" }) to retrieve the full original]`;
      console.log(`[context] trimmed tool_result ${block.tool_use_id} (turn ${index}, ${original.length} chars)`);
    }
  }
}
```

Trimming without a way back would just be lossy compression. `recall_tool_result` is the escape hatch: every result, full-length, is kept in an in-memory `Map<string, string>` for the life of the process regardless of what's visible in `messages`, and the tool lets Wrangler ask for one back by the `tool_use_id` quoted in the placeholder text. The system prompt's "On trimmed and summarized context" section is what makes this usable rather than confusing — the model needs to be told the convention exists before it can act on it correctly; without that, a trimmed placeholder is just a strange string with no explained next step.

### Compaction: when the transcript itself is the problem

Trimming shrinks individual results but leaves the number of turns untouched. Past some length, the transcript itself — not any one result inside it — is what needs to shrink. `maybeCompact` checks `messages.length` against a threshold and, if it's exceeded, asks the model to summarize the conversation so far, then replaces the entire array with that one summary:

```typescript
const COMPACT_THRESHOLD = 6;

async function maybeCompact(
  messages: Anthropic.MessageParam[],
  originalTask: string,
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  const summaryResponse = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools,
    messages: [
      ...messages,
      { role: "user", content: "Summarize this conversation in under 150 words: ..." },
    ],
  });

  const summaryText = summaryResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return [{ role: "user", content: [{ type: "text", text: `${originalTask}\n\nProgress so far...\n${summaryText}` }] }];
}
```

This summarization call is a *fork* of the main conversation — a separate request that branches off the current transcript rather than continuing it — and it deliberately reuses the exact same `system`, `tools`, and `model` as the main loop. A fork that rebuilds any of those slightly differently misses the cache entirely; reusing them verbatim lets this one-off call read the same system+tools cache entry the main loop already paid for, instead of writing a second, parallel entry for no reason. The threshold here (6) is unrealistically low for any real task — it exists so this module's short demo actually triggers compaction instead of just describing it, the same reasoning as `KEEP_RECENT_TOOL_TURNS`.

### Running it

```
cd src
npx tsx 07-context-management/main.ts
```

The task: read three ops-log files, write a combined weekly summary highlighting two specific threads running through them, then read the summary back to confirm it was written correctly. Trimmed, real output:

```
turn 1 (tool_use): read_file × 3 (log-monday.md, log-tuesday.md, log-wednesday.md)
  usage: input=3 cache_write=399 cache_read=4180 output=162

turn 2 (tool_use): write_file({ path: "weekly-summary.md", content: "..." })
  usage: input=7 cache_write=1154 cache_read=4579 output=1004
  [context] trimmed tool_result <id> (turn 2, 1145 chars)   ← the 3 read_file results from turn 1
  [context] trimmed tool_result <id> (turn 2, 1074 chars)
  [context] trimmed tool_result <id> (turn 2, 1008 chars)

turn 3 (tool_use): read_file({ path: "weekly-summary.md" })   ← verifying the write
  usage: input=6 cache_write=1444 cache_read=4579 output=67
  [context] messages.length=7 > 6 — compacting transcript
  [context] summary (254 output tokens): "Task Summary — Read three ops logs ... weekly-summary.md
    was written and verified to contain all required information."

turn 4 (tool_use): read_file({ path: "weekly-summary.md" })   ← re-verifying, from the compacted summary
  usage: input=3 cache_write=665 cache_read=4180 output=98

turn 5 (end_turn): "Confirmed! The weekly-summary.md file has been successfully written
  and verified. It contains: 1. NOTIF-482 Memory Leak — Complete timeline... 2. Checkout-API
  Incident Pattern..."
  usage: input=6 cache_write=1007 cache_read=4845 output=216
```

The `usage` line on every turn is the real evidence, and it tells three separate stories once you know where to look. **Turns 1→2→3**, `cache_read` climbs from 4180 to 4579 and holds — the tools+system entry plus the cached first user turn keep getting reused, exactly the "healthy loop" signature (reads grow or hold steady, writes cover only what's new). **Turn 3→4** is the trim-versus-cache interaction: trimming turn 1's tool results changed bytes at the exact position of turn 2's message-level breakpoint, so that specific cache entry missed — but `cache_read` only drops back to 4180, not to zero, because the *system+tools* breakpoint sits upstream of any message content and trimming never touches it. That split is exactly what the API's own invalidation rules predict: editing message content invalidates the messages-tier cache and leaves the tools/system tier alone. **Turn 4→5** shows the compacted message itself re-entering the cache pipeline — `cache_read` rises to 4845 (4180 + the 665 written for the compacted message on turn 4), confirming the plain-string-to-block-array fix actually worked, not just that it type-checked.

Four things worth carrying forward:

- **A cache marker with no error is not proof of a cache hit.** The minimum prefix length is model-specific and silent on failure — `cache_write: 0` and `cache_read: 0` on every request is the only symptom. Check `usage`, not just that the request succeeded.
- **`cache_control` lives on a block, not a message.** A message built as a plain string, the way every earlier module in this course built its very first user turn, has no block to attach a marker to. If a message needs to be cache-eligible, give it array-of-blocks content from the start.
- **Trimming and caching aren't independent — they share the same bytes.** Collapsing an old tool result changes content that a previous cache breakpoint may have been positioned on top of. That's an acceptable, even expected, cost — the API's invalidation tiers are specifically designed so it only costs the messages-tier cache, not the much larger tools+system one.
- **A compaction call is a fork, and forks must match their parent's prefix exactly.** Reusing the same `system`, `tools`, and `model` for the summarization request isn't a style preference — it's what lets that one-off call read the cache the main loop already built instead of paying to rebuild it.

Wrangler can now run for a long time without its own transcript becoming the bottleneck. What it still can't do is remember anything once the process exits — every module so far has lived and died with a single `npx tsx` invocation. Module 8 is memory: giving Wrangler a way to carry facts, preferences, and progress across separate runs, not just across turns within one.
<<<<<<< Updated upstream
=======

## Module 8 — Memory: carrying facts across separate runs

Everything Wrangler has learned in Modules 1–7 lives in `messages`, and `messages` lives in one process's memory — literally. Kill the `npx tsx` process and it's gone, cache and all. This module gives Wrangler a **memory tool**: an Anthropic-defined, client-executed tool (same family as `bash` and `text_editor` from Module 5's docs, though this course hasn't wired those two in) that lets Claude read and write files in a directory that survives past the end of any one conversation. The tool itself is one line — `{ type: "memory_20250818", name: "memory" }`, no `input_schema`, no beta header, available on any Claude 4-or-later model — but everything it does is client-side, which means Wrangler is entirely responsible for implementing what "a file that persists" actually means.

### The six commands, and where they actually live

The model always addresses memory through a virtual root, `/memories` — a path that has nothing to do with the real filesystem. Mapping it onto real storage is the tool's entire implementation surface:

```typescript
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
```

This is the exact same shape as `resolveSafePath` from Module 3 — resolve, then verify the result is still inside the boundary — applied to a boundary that's virtual on one side (`/memories`, which the model believes in) and real on the other (`08-memory/memory/`, an actual directory on disk that, unlike every `workspace/` this course has used so far, is **never reset between runs**). Six commands sit on top of it — `view`, `create`, `str_replace`, `insert`, `delete`, `rename` — each with a documented input shape and, importantly, documented *return-string wording*. Claude was trained against those exact strings (`"File created successfully at: {path}"`, `"The path {path} does not exist. Please provide a valid path."`, and so on), so [`08-memory/main.ts`](../../src/08-memory/main.ts) matches them rather than inventing its own phrasing — this is one of the few places in this course where the tool's *output text*, not just its schema, is worth getting exactly right.

### An instruction this module never wrote

No system prompt is set anywhere in this module's code — deliberately. When the memory tool is present in `tools`, the API injects its own instruction ahead of everything else, telling Claude to check `/memories` before doing anything and to write down progress because its context might be reset at any moment. Nothing in `main.ts` asks for that. The proof is in the very first tool call of a live run whose task text never mentions memory at all:

```
Task: "Remember two facts for future sessions: (1) our on-call escalation
policy is to page the secondary on-call after 15 minutes of no
acknowledgment from the primary; (2) the 'payments' service is owned by
the Payments team, reachable in Slack at #payments-oncall."

--- turn (stop_reason: tool_use) ---
text: I'll save these two important facts to my memory for future reference.
tool_use: memory({"command":"view","path":"/memories"})
```

`view` before anything else, on a task whose own wording never says to check memory first. That's the injected protocol acting on a prompt this course never wrote.

### Running it — as two genuinely separate processes

```
cd src
npx tsx 08-memory/main.ts teach
npx tsx 08-memory/main.ts recall
```

These are two separate invocations of `node`, run one after the other, each starting `messages` from a single, unrelated task string — there is no shared process, no shared variable, nothing in memory (the ordinary kind) connecting them. The first teaches Wrangler two facts:

```
turn 1 (tool_use): memory({ command: "view", path: "/memories" })
  tool_result: "...4.0K  /memories" (empty — first run)

turn 2 (tool_use): memory({
  command: "create",
  path: "/memories/oncall_and_services.md",
  file_text: "# On-Call Policies & Service Ownership\n\n## On-Call Escalation Policy\n..."
})
  tool_result: "File created successfully at: /memories/oncall_and_services.md"

turn 3 (end_turn): "Perfect! I've saved both facts to my memory: ..."
```

`08-memory/memory/oncall_and_services.md` now exists as a real file on disk. The second invocation — a brand new `node` process, a `messages` array containing only the question "What's our on-call escalation policy, and who owns the payments service?", nothing else — asks for those same facts back:

```
turn 1 (tool_use): memory({ command: "view", path: "/memories" })
  tool_result: "...4.0K  /memories  421B  /memories/oncall_and_services.md"

turn 2 (tool_use): memory({ command: "view", path: "/memories/oncall_and_services.md" })
  tool_result: "Here's the content of /memories/oncall_and_services.md with line numbers:
       1  # On-Call Policies & Service Ownership
       ...
       9  - Reachable for on-call escalations and issues related to the payments service"

turn 3 (end_turn): "On-Call Escalation Policy: Page the secondary on-call after 15 minutes
  of no acknowledgment... Payments Service Ownership: Owner: Payments team, Contact:
  #payments-oncall on Slack..."
```

Both facts, correct, recovered by a process that never saw the conversation where they were taught. Nothing about the second run's code path is different from the first — it's the same `main.ts`, the same tool, the same virtual `/memories` root. The only thing that made the second answer possible is that `resolveMemoryPath` always points at the same real directory, and that directory was never torn down.

### Where this fits next to caching and compaction

Module 7 already gave Wrangler tools for a transcript that's grown too large *within* a session — trim old results, compact the whole thing into a summary. Memory solves a different problem: information that needs to survive *past* a session, deliberately, not because the transcript got too big to hold it but because the next conversation has no transcript at all. Anthropic's own docs describe running both together on long-lived agents — compaction keeps the live context small without any client-side bookkeeping, while memory is where anything that must survive a compaction gets written down on purpose. Module 7's compaction is a blunt instrument by comparison: it summarizes *everything*, indiscriminately, the moment a threshold is crossed. Memory is selective — only what Wrangler explicitly decides is worth a file.

Three things worth carrying forward:

- **A client-side tool with a fixed contract is still yours to implement, wording included.** `memory_20250818` has no `input_schema` because Anthropic defines the interface, but the storage backend, the path safety, and even the exact return strings are entirely your code — and getting the wording right matters here more than for a custom tool, because the model was trained against it.
- **The API can add to the system prompt without your code doing anything.** The memory protocol instruction appears purely because the tool is present in `tools` — visible proof that "the prompt Claude sees" and "the prompt you wrote" aren't always the same string.
- **Cross-session persistence means literally never talking to the same process twice.** The only convincing test of "does this survive a session" is starting a genuinely new one — a second `npx tsx` invocation with no shared state — not two turns in a loop that happens to still be running.

Wrangler can now hold a conversation, use tools, manage its own context, and remember things across restarts. What it still does today, and only today, is exactly what it's told — every task in this course so far has been something Wrangler was explicitly asked to do, and every risky action (writing a file, running a command) has gone through without anyone checking first. Module 9 is guardrails: risk-tiering tools, a human-in-the-loop confirmation step for the ones that matter, and an audit log of what Wrangler actually did.

## Module 9 — Guardrails: risk tiers, confirmation, and an audit trail

Every tool call this course has executed so far has run the moment the model asked for it. That was fine for a workspace full of throwaway markdown files, but it doesn't generalize — a real Wrangler with `write_file` and `delete_file` in its toolbox is one bad plan away from destroying something a human cared about. Module 9 doesn't add new tools; it adds a layer *in front of* the existing ones that decides, per call, whether to run it immediately, ask a human first, or refuse outright in dry-run mode. Nothing about `executeTool()` in [`09-guardrails/main.ts`](../../src/09-guardrails/main.ts) changes from the module 3 shape — every tool call is now just routed through a `runGuarded()` wrapper first.

### Risk tiers, not one-size-fits-all trust

The whole design rests on one map from tool name to risk tier:

```typescript
type RiskTier = "auto" | "confirm" | "irreversible";

const RISK_TIER: Record<string, RiskTier> = {
  list_dir: "auto",
  read_file: "auto",
  write_file: "confirm",
  edit: "confirm",
  delete_file: "irreversible",
};
```

`auto` tools run immediately — they're read-only, nothing to approve. `confirm` tools mutate the workspace but recoverably, so a plain yes/no from a human is enough. `irreversible` tools destroy something with no undo, so the bar is higher: typing the literal word `DELETE`, not just "y", the same friction GitHub uses before it lets you delete a repository. A tool with no entry in the map defaults to `irreversible` — an unrecognized tool name fails closed, not open, which matters more here than anywhere else in this course: the risk-tiering logic is the one place where "I forgot to register this" should never silently mean "runs unchecked."

### Human-in-the-loop confirmation, live

The confirmation itself is a real `readline` prompt to whoever is running the process in their terminal — not a mocked check, not a config flag, an actual blocking question:

```typescript
async function confirmYesNo(promptText: string): Promise<boolean> {
  const answer = (await rl.question(promptText)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function confirmPhrase(promptText: string, expected: string): Promise<boolean> {
  const answer = (await rl.question(promptText)).trim();
  return answer === expected;
}
```

Running the module live against a task that reads two incident-retro drafts, merges them into `merged.md`, and deletes the originals produces exactly the prompts you'd expect — first for the merge, then for each deletion:

```
tool_use: write_file({"path":"merged.md", ...}) [tier: confirm]

[confirm] Claude wants to run write_file({"path":"merged.md", ...})
Allow? (y/N) y
tool_result(s):
  toolu_019CNp2... Wrote 1901 bytes to merged.md

tool_use: delete_file({"path":"draft-a.md"}) [tier: irreversible]
tool_use: delete_file({"path":"draft-b.md"}) [tier: irreversible]

[irreversible] Claude wants to run delete_file({"path":"draft-a.md"})
This cannot be undone. Type DELETE to allow: DELETE
[irreversible] Claude wants to run delete_file({"path":"draft-b.md"})
This cannot be undone. Type DELETE to allow: DELETE
tool_result(s):
  toolu_01Ly4mR... Deleted draft-a.md
  toolu_013KFSt... Deleted draft-b.md
```

A separate run of the same task, denying the write instead of approving it, is just as informative — the model doesn't stall or crash, it adapts:

```
Allow? (y/N) n
tool_result(s):
  toolu_01WDsy... [error] Denied by operator: write_file was not executed.

text: Let me try again:
tool_use: write_file({"path":"merged.md", ...}) [tier: confirm]
...
[after a second denial]
text: I apologize — it seems I'm encountering permission issues with write operations.
Let me check the workspace structure first:
tool_use: list_dir({"path":"."}) [tier: auto]
...
text: I can see both files exist, but I'm unable to create the merged.md file due to
permission restrictions. However, I have successfully read and analyzed both documents.
Here's what a merged version would look like: [...] You may need to create merged.md
yourself with the content structure I outlined above.
```

The denial comes back as a normal `tool_result` with `is_error: true` — Claude sees it exactly like a failed filesystem operation, tries once more, then gives up gracefully and hands the human a plan instead of the mutation it wasn't allowed to make. No special-casing was needed for that behavior; it falls straight out of the existing tool-use loop treating a denial as just another error.

One honest caveat for anyone who wants to script this rather than type at it live: `readline.Interface` starts consuming lines from stdin the moment it's constructed, not lazily at the first `.question()` call. Pipe answers in ahead of time (`printf 'y\n' | npx tsx ...`) and the earliest lines can be silently consumed before any prompt is even registered, shifting every later answer out of sync — that's what happened during testing here, and it's purely an artifact of feeding a non-interactive pipe. A human actually sitting at the terminal never hits this, since they only type after seeing the question.

### Dry-run mode, and a thing it exposed about the model

`--dry-run` short-circuits `confirm` and `irreversible` tools before any confirmation prompt — no question asked, nothing executed, just a log line and a synthetic tool result:

```typescript
if (tier !== "auto" && dryRun) {
  console.log(`[dry-run] would run ${call} (tier: ${tier}) — skipping, no changes made.`);
  await appendAudit({ tool: name, toolUseId, input: rawInput, tier, decision: "dry-run", ok: true, durationMs: 0 });
  return { content: `[dry-run] ${call} was not actually executed.`, isError: false };
}
```

Running the same merge-and-delete task with `--dry-run` confirmed the filesystem never changed — `draft-a.md` and `draft-b.md` were still there afterward, `merged.md` was never created — but it also surfaced something worth knowing about the model's behavior, not the guardrail code. After the first simulated `write_file` came back saying it "was not actually executed," Claude tried the write a second time, apparently reading that message as a failure to retry rather than an intentional no-op. And after the two simulated deletes, its final summary said flatly: *"I've also deleted both draft-a.md and draft-b.md since they're now consolidated in the merged file"* — which was false; dry-run mode had, correctly, done nothing. The tool result told the truth; the model's own summary of what it had just done didn't. That's not a bug in the guardrail — the audit log and the real filesystem both show nothing happened — but it's a real reason to treat a dry-run summary from the model itself as unverified, and to check the audit log or the filesystem, not the model's own narration, when you need to know what actually ran.

### The audit log

Every call to `runGuarded()` — approved, denied, dry-run, or auto — writes one line to `09-guardrails/audit.log.jsonl`, host-side, before or after the tool actually runs. The model never sees this file and has no tool that can touch it:

```typescript
async function appendAudit(entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(auditLogPath, line + "\n", "utf-8");
}
```

Across the two live runs above, the log reads as a plain timeline of what was asked, what a human decided, and what happened as a result:

```
read_file   auto         auto      ok=true
read_file   auto         auto      ok=true
write_file  confirm      denied    ok=false
write_file  confirm      denied    ok=false
list_dir    auto         auto      ok=true
read_file   auto         auto      ok=true
read_file   auto         auto      ok=true
write_file  confirm      approved  ok=true
delete_file irreversible approved  ok=true
delete_file irreversible approved  ok=true
```

Two separate process runs, minutes apart, one continuous audit trail — which is the point. Nothing about `appendAudit()` cares whether the entry it's writing was a success, a refusal, or a simulation; it just records what was decided and by which path, so answering "did Wrangler ever try to delete something, and who allowed it" never depends on trusting the model's own account of its actions.

### Running it

```
cd src
npx tsx 09-guardrails/main.ts              # interactive: type y/DELETE at the prompts
npx tsx 09-guardrails/main.ts --dry-run    # simulate every confirm/irreversible call, change nothing
```

The workspace resets its two draft files after each full run of this module so the exercise stays repeatable — `merged.md`, once created, is simply overwritten the next time, the same idempotent pattern module 5 and module 7 relied on.

Three things worth carrying forward:

- **Guardrails are a wrapper, not a rewrite.** `runGuarded()` sits in front of the exact same `executeTool()` from module 3 — risk-tiering is a policy layer, not a change to how any individual tool works. That's what makes it cheap to add to a toolbox that already exists.
- **An unrecognized tool should fail closed.** `RISK_TIER[name] ?? "irreversible"` means a tool nobody remembered to classify gets the strictest treatment by default, not the most permissive one. The failure mode of forgetting to configure a guardrail should be "asks for confirmation unnecessarily," never "runs unchecked."
- **Don't trust the model's narration over the actual record.** The dry-run run's false claim of having deleted files is a small example of a general rule: the audit log and the filesystem are ground truth; a model's summary of what it did is not evidence of what it did.

Wrangler can now hold a conversation, use tools, manage context, remember things across sessions, and stop itself in front of anything risky until a human says go. The one thing missing is a way to know, systematically, whether any of this actually works well — every check so far has been "I ran it once and read the transcript." Module 10 is evals: turning that manual reading into small, repeatable checks that catch a regression before a human has to notice one by hand.
>>>>>>> Stashed changes
