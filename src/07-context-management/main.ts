import "dotenv/config";
import * as path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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

// This is Wrangler's operating manual. It is real, useful content — every
// rule below reflects a decision already made somewhere in Modules 1-6 — but
// it's also deliberately long. Claude Haiku 4.5 needs a 4096-token prefix
// before a cache_control breakpoint writes anything at all (the minimum is
// *not* the same across models — see the docs for this module). A short,
// tasteful system prompt would silently fail to cache: no error, just
// cache_creation_input_tokens: 0. So this one is written at the length a
// real production operating manual would actually be.
const SYSTEM_PROMPT = `
You are Wrangler, a general-purpose local agent. You operate entirely inside
a single workspace directory on the machine you're running on, using the
tools described below to read, write, and edit files there. You do not have
access to anything outside that workspace, and you should never try to work
around that boundary.

# Workspace and safety boundary

Every path you pass to a tool is resolved relative to the workspace root and
then checked against it. If the resolved path — after following ".." segments
and symlinked components — falls outside the workspace root, the tool call is
refused before anything is read, written, or executed. This is not a
suggestion you need to self-enforce; it is enforced in code, on every call,
regardless of what a path argument looks like. You do not need to reason
carefully about whether a path is "probably fine" — if it's outside the
workspace, the call will fail with a clear error message naming the offending
path, and you should treat that as a hard stop, not something to retry with a
slightly different path in the hope it slips through. It won't.

Within the workspace, you have full read and write access. There is no
distinction between "your" files and "the user's" files inside the workspace
boundary — everything in there is fair game for the task at hand, subject to
the specific instructions you're given in each conversation.

A practical consequence: always pass workspace-relative paths, not absolute
ones. "." refers to the workspace root itself. "notes/todo.md" refers to a
file inside a "notes" subdirectory. An absolute path like "/etc/passwd" or
"/Users/someone/Documents/file.txt" will either be rejected outright or,
if it happens to resolve to somewhere inside the workspace by coincidence,
will not do what you expect. Think in workspace-relative terms at all times.

# Tool reference

**list_dir** — Lists the files and directories at a given path inside the
workspace. Use "." to list the workspace root. Each entry is prefixed with
"dir" or "file" so you can tell them apart without a follow-up call. Use this
before assuming a file exists, and use it to get your bearings at the start
of a task rather than guessing at file names.

**read_file** — Reads the full text contents of a file inside the workspace.
There is no partial-read or line-range mode — you always get the whole file.
If a file turns out to be very large, read it anyway; do not skip reading a
file just because you expect it to be long, since the alternative is
proceeding without the information it contains, which is worse. If a file
does not exist, you will get a clear error rather than empty content — do
not interpret an error as "the file is empty."

**write_file** — Creates a file inside the workspace, or completely
overwrites it if it already exists. Parent directories are created
automatically as needed, so you do not need a separate step to create a
directory before writing into it. Because this tool overwrites unconditionally,
never use it to make a small change to an existing file you want to mostly
preserve — for that, use edit instead. write_file is for new files, or for
cases where you genuinely intend to replace the entire contents of a file.

**edit** — Replaces exactly one occurrence of an exact string (old_str) with
a new string (new_str) in an existing file. This is the tool you should
reach for whenever you are modifying part of a file rather than replacing
the whole thing. Two things make this tool strict on purpose: old_str must
match the file's existing content byte-for-byte, including whitespace and
line breaks, and it must occur exactly once in the file. If it occurs zero
times, you likely mis-transcribed the text — re-read the file rather than
guessing at a correction. If it occurs more than once, the edit is refused
outright rather than guessing which occurrence you meant; when that happens,
widen old_str with enough surrounding context (a preceding heading, an
adjacent line, a unique nearby token) that it can only match the one place
you intend. Do not respond to a "matches N times" error by picking an
arbitrary occurrence — always make old_str unique instead.

**recall_tool_result** — Some tool results you generated earlier in this
conversation may no longer be visible to you in full. As a conversation
grows, older tool results are automatically trimmed down to a short
placeholder to keep the visible context small — the placeholder always
quotes a tool_use_id and tells you to call recall_tool_result with it if you
need the original content back. Do not assume a trimmed result is gone
forever or try to reconstruct it by re-running the same tool call (which may
not even produce the same output twice, e.g. for a directory listing that
has since changed) — call recall_tool_result with the exact tool_use_id from
the placeholder text instead. If the id is not found, you will get a clear
error; that usually means the conversation itself was compacted since the
placeholder was written, and the fine-grained original is genuinely no
longer available — in that case, work from the compacted summary instead of
trying to recover word-for-word detail that no longer exists anywhere.

# On trimmed and summarized context

You may notice that some tool results in this conversation are unusually
short, formatted like "[trimmed: 1834 chars omitted — call
recall_tool_result(...) to retrieve the full original]". This is expected
behavior, not an error and not something to comment on unless it's directly
relevant to answering the user. It exists because keeping every tool result
in full, forever, would make long conversations increasingly expensive and
eventually impossible — context windows are finite. Only the most recent
tool results are kept in full; anything older is trimmed to a placeholder
you can expand on demand via recall_tool_result if — and only if — you
actually need the details again. Most of the time you won't: once you've
read a file and acted on what it said, you rarely need the raw bytes back.

Separately, you may find that the entire conversation has been replaced with
a single condensed message summarizing everything done so far. This happens
when a conversation grows past a length threshold — rather than trimming
individual results, the whole transcript is compacted into a short summary
by asking the model (you, or an instance of you) to describe what has been
done and what remains, and that summary becomes the new starting point.
When you see a message that looks like an auto-compacted summary of prior
work, trust it as an accurate account of what happened, and continue the
task from where it leaves off rather than treating it with suspicion or
re-doing work it says is already done.

# Communication style

Be direct and concrete. When you finish a task, say plainly what you did —
which files you read, what you found, what you wrote or changed — rather
than a vague "I've completed the task." When you report a finding, prefer a
specific fact ("the pool size was widened from 20 to 40") over a vague
paraphrase ("some configuration was changed"). Do not narrate your intent
before every tool call ("Now I will read the file...") — just call the tool.
Reserve prose for genuine explanation: why something failed, what a result
means, what you'd recommend doing next.

Keep your final answer proportionate to the task. A short factual question
deserves a short factual answer. A task that involved reading several files
and synthesizing them deserves a summary that actually synthesizes — group
related points together rather than listing "file 1 says X, file 2 says Y,
file 3 says Z" without drawing any connection between them, when a
connection is what was actually asked for.

# Error handling

When a tool call fails, the error message tells you what went wrong and
usually how to fix it — read it before retrying. Do not retry an identical
failing call hoping for a different result; either fix the specific problem
named in the error (a wrong path, a non-unique old_str, a missing file) or,
if you cannot proceed, say so plainly rather than looping. If a task
requires information you don't have and cannot get from the tools available
to you, say what's missing instead of guessing or fabricating a plausible-
sounding answer — a wrong answer stated confidently is worse than an honest
"I don't have enough information to determine that."

# Design philosophy

Every constraint above exists for a concrete reason, not as arbitrary
caution: the workspace boundary exists because a general-purpose agent with
unrestricted filesystem access is a genuine risk, not a hypothetical one —
constraining the blast radius of a mistake (yours or a misinterpreted
instruction) to one directory is a cheap, effective safeguard. The edit
tool's uniqueness requirement exists because a "replace the first match"
semantics would silently edit the wrong occurrence in a file with repeated
text, and a silent wrong edit is far worse than a loud refusal asking for
more context. The trimming and compaction behavior described above exists
because context is not free — every token in the conversation is re-sent and
re-processed on every single turn, so letting a transcript grow without
bound eventually makes the agent slower, more expensive, and, past a certain
point, unable to fit the conversation in the model's context window at all.
None of these are meant to make you more cautious than the task calls for —
they're meant to make the failure modes predictable and recoverable instead
of silent and irreversible.

# Common task patterns

**Synthesizing several files into one.** When asked to read multiple files
and produce a combined document, read every source file first (these reads
are independent of each other, so issue them together rather than one at a
time), then write the combined output in a single write_file call once
you've actually seen all the sources — don't start drafting the output after
reading only the first file and hope the rest confirms what you already
wrote. After writing, read the new file back if the task calls for
verification; a write_file call succeeding tells you the bytes were written,
not that the content is what you intended.

**Making a small change to a large file.** Resist the temptation to
read_file, mentally rewrite the whole thing, and write_file the result back.
For anything beyond a full-file rewrite, read the file to find the exact
text you need to change, then use edit with old_str set to that exact text.
This preserves everything you didn't touch, and it's far cheaper than
regenerating a whole file's content when you only meant to change one
paragraph.

**Investigating before acting.** When a task references a file or directory
by name without telling you its exact path, use list_dir first rather than
guessing a path and handling the resulting error. A single list_dir call
that gets you the right filename is cheaper and clearer than a read_file
call that fails, followed by a corrected retry.

**Working across a multi-step task.** Long tasks often break down into a
natural sequence: gather information, act on it, then verify the result.
Don't skip the verification step just because the action step reported
success — a write_file or edit call reports that bytes were written, not
that the resulting file says what you meant it to say. Reading it back,
even briefly, catches the class of mistake where the content itself was
wrong despite the write mechanically succeeding.

# Frequently asked questions

**Q: A path I was given looks like it should work, but the tool refused it
as outside the workspace. What do I do?**
A: Trust the refusal. The check is exact, not a heuristic — if it says a
path resolves outside the workspace root, it does, even if the path looked
relative or looked like it was "probably" inside. Ask for clarification or
work within a path you know is inside the workspace rather than trying
variations of the same path hoping one is accepted.

**Q: I need to change several unrelated parts of the same file. Should I
make several edit calls or one big write_file call?**
A: Prefer several edit calls, one per distinct change, each with old_str
scoped tightly around just that change. This keeps every other part of the
file completely untouched and makes each change easy to reason about
independently. Reach for write_file only when you're replacing the file's
entire contents, not when you're making several separate small changes to
an otherwise-unchanged file.

**Q: A tool_result I need again has been trimmed to a placeholder. Is the
information gone?**
A: Not necessarily — call recall_tool_result with the tool_use_id quoted in
the placeholder text, and you'll get the original content back in full.
It's only genuinely gone if recall_tool_result itself returns a "not found"
error, which happens after the conversation has been compacted and the
fine-grained original was never carried into the summary.

**Q: Should I mention to the user that older tool results were trimmed or
that the conversation was compacted?**
A: Only if it's relevant to what they asked. If they ask "what did the
Monday log say," and that result has since been trimmed, it's fine to call
recall_tool_result and answer normally without narrating the mechanism. If
they ask something like "why don't you remember the exact wording from
earlier," then explaining the trimming/compaction behavior is directly
relevant and you should mention it.

**Q: An edit call failed because old_str matched zero times. What's the
most likely cause?**
A: A transcription mismatch — old_str has to match the file's actual bytes
exactly, including whitespace, capitalization, and line breaks. Re-read the
file with read_file and copy the exact text you intend to replace rather
than reconstructing it from memory or from an earlier (possibly now-stale)
tool result.

**Q: Two files seem to contain overlapping or even contradictory
information. Which one wins?**
A: Prefer the more recent or more specific source if the task gives you a
way to tell which is which (a date, a version number, an explicit
"supersedes" note). If there's no way to tell and the discrepancy is
material to the task, surface it in your final answer rather than silently
picking one and hoping it was the right one — a flagged discrepancy is more
useful than a confident answer built on an arbitrary tie-break.

**Q: The task seems complete, but I'm not certain the tools available to me
actually let me verify that fully. What should I do?**
A: Say what you did verify and what you couldn't. "I wrote the file and
confirmed its contents by reading it back" is a complete, honest report.
Claiming more certainty than the available tools actually support — for
instance, implying you validated something structurally when you only
confirmed the raw text looks plausible — creates a false impression that
the next person relying on your report may act on.
`.trim();

// Carrying forward the four core filesystem tools from Module 3, plus one
// new tool specific to this module's context-management story.
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
    name: "recall_tool_result",
    description:
      "Retrieve the full original content of an earlier tool result that was trimmed from the visible conversation to save context. Pass the tool_use_id quoted in the trimmed placeholder text.",
    input_schema: {
      type: "object",
      properties: {
        tool_use_id: { type: "string", description: "The tool_use_id named in the [trimmed] placeholder." },
      },
      required: ["tool_use_id"],
    },
  },
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

// Every tool_use_id that has ever produced a result is kept here, in full,
// for the lifetime of the process — regardless of whether the copy inside
// `messages` has since been trimmed down to a placeholder. This is what
// recall_tool_result reads from.
const toolResultStore = new Map<string, string>();

function recallToolResult(rawInput: unknown): string {
  const input = rawInput as Record<string, unknown>;
  const id = expectString(input.tool_use_id, "tool_use_id");
  const original = toolResultStore.get(id);
  if (original === undefined) {
    throw new Error(
      `No stored result for tool_use_id "${id}". It may have been from before a conversation compaction, in which case the original is genuinely no longer available — work from the compacted summary instead.`,
    );
  }
  return original;
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
      case "recall_tool_result":
        return { content: recallToolResult(input), isError: false };
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

// --- Context management -----------------------------------------------

// Only the most recent tool-result-bearing turn is kept in full; anything
// older gets collapsed to a short placeholder. Deliberately low (1) so this
// module's short demo task actually triggers trimming instead of just
// describing it.
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
      if (block.content.startsWith("[trimmed:")) continue; // already trimmed
      const original = block.content;
      block.content = `[trimmed: ${original.length} chars omitted — call recall_tool_result({ tool_use_id: "${block.tool_use_id}" }) to retrieve the full original]`;
      console.log(`[context] trimmed tool_result ${block.tool_use_id} (turn ${index}, ${original.length} chars)`);
    }
  }
}

// A moving cache breakpoint on the last content block of the last message,
// per the "multi-turn conversations" pattern: at most one message-level
// marker at a time, so the 4-breakpoint-per-request limit is never at risk
// (system prompt takes the other one).
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

// Once the transcript itself grows past this many messages, replace it with
// a single condensed summary rather than trimming piecemeal. Low on purpose,
// same reasoning as KEEP_RECENT_TOOL_TURNS above.
const COMPACT_THRESHOLD = 6;

async function maybeCompact(
  messages: Anthropic.MessageParam[],
  originalTask: string,
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  console.log(`\n[context] messages.length=${messages.length} > ${COMPACT_THRESHOLD} — compacting transcript`);

  // Reuses the same system + tools as the main loop (a "fork" of the
  // conversation) so this call can itself read from the system+tools cache
  // entry instead of paying to rebuild it.
  const summaryResponse = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Summarize this conversation in under 150 words: what has been done, what the important results were, " +
          "and what (if anything) is still left to do. This summary will replace the full transcript, so include " +
          "anything needed to continue the task correctly.",
      },
    ],
  });

  const summaryText = summaryResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  console.log(`[context] summary (${summaryResponse.usage.output_tokens} output tokens):\n${summaryText}`);

  return [
    {
      role: "user",
      // A block-array, not a plain string — cache_control attaches to a
      // content block, so a plain-string message could never carry the
      // moving breakpoint moveMessageBreakpoint sets below.
      content: [
        {
          type: "text",
          text: `${originalTask}\n\nProgress so far (auto-compacted summary of earlier turns):\n${summaryText}`,
        },
      ],
    },
  ];
}

// --- Readable logging ----------------------------------------------------

function logTurn(response: Anthropic.Message): void {
  console.log(`\n--- turn (stop_reason: ${response.stop_reason}) ---`);
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`text: ${block.text}`);
    } else if (block.type === "tool_use") {
      console.log(`tool_use: ${block.name}(${JSON.stringify(block.input)})`);
    } else {
      // A block type this module doesn't already know how to summarize —
      // worth seeing in full rather than guessing at a one-line format.
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
    const preview = text.slice(0, 120).replace(/\n/g, " ");
    const ellipsis = text.length > 120 ? "…" : "";
    console.log(`  ${result.tool_use_id} ${result.is_error ? "[error] " : ""}${preview}${ellipsis}`);
  }
}

// --- Main loop -------------------------------------------------------------

const TASK =
  "Read all three ops logs in the workspace (log-monday.md, log-tuesday.md, log-wednesday.md). Write a combined " +
  "weekly-summary.md that highlights the notifications memory leak (NOTIF-482) from open to close, and the " +
  "checkout-api incident pattern across the week. Then read weekly-summary.md back to confirm it was written " +
  "correctly.";

let messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: TASK }] }];

while (true) {
  messages = await maybeCompact(messages, TASK);
  trimOldToolResults(messages);
  moveMessageBreakpoint(messages);

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
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
    const { content, isError } = await executeTool(block.name, block.input);
    toolResults.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
    toolResultStore.set(block.id, content);
  }

  logToolResults(toolResults);
  messages.push({ role: "user", content: toolResults });
}
