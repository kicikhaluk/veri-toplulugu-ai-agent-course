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
