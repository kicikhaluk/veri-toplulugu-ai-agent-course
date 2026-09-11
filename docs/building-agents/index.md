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
