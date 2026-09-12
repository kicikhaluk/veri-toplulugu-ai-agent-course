import "dotenv/config";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runWrangler } from "./wrangler.js";

const client = new Anthropic();
const workspaceRoot = path.resolve(import.meta.dirname, "workspace");

// From the parent's point of view, Wrangler is just another tool — one
// input (a task string), one output (Wrangler's final text). The parent
// never sees the read_file/write_file calls happening underneath it.
const delegateTool: Anthropic.Tool = {
  name: "delegate_to_wrangler",
  description:
    "Hand a filesystem task off to Wrangler, a document-editing agent with its own read/write/edit/delete tools " +
    "over the shared workspace. Wrangler runs its own multi-turn loop to completion and reports back only its " +
    "final answer — you don't see its intermediate steps, and it has no memory of this conversation.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "A complete, self-contained instruction for Wrangler — it cannot see anything said here.",
      },
    },
    required: ["task"],
  },
};

const PARENT_SYSTEM_PROMPT =
  "You are a coordinator. You never read or write files yourself — for any task that touches the workspace, " +
  "delegate it to the delegate_to_wrangler tool with a complete, self-contained instruction, then summarize " +
  "what it reports back.";

async function runParent(userRequest: string): Promise<void> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userRequest }];

  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: PARENT_SYSTEM_PROMPT,
      tools: [delegateTool],
      messages,
    });

    console.log(`\n--- parent turn (stop_reason: ${response.stop_reason}) ---`);
    for (const block of response.content) {
      if (block.type === "text") console.log(`parent text: ${block.text}`);
      else if (block.type === "tool_use") console.log(`parent tool_use: ${block.name}(${JSON.stringify(block.input)})`);
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.name !== "delegate_to_wrangler") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: no such tool "${block.name}"`,
          is_error: true,
        });
        continue;
      }

      const { task } = block.input as { task: string };
      console.log(`  [wrangler] starting nested run — task: ${task}`);
      const result = await runWrangler(workspaceRoot, task, {
        onTurn: (child) => {
          for (const childBlock of child.content) {
            if (childBlock.type === "text") console.log(`  [wrangler] text: ${childBlock.text}`);
            else if (childBlock.type === "tool_use") {
              console.log(`  [wrangler] tool_use: ${childBlock.name}(${JSON.stringify(childBlock.input)})`);
            }
          }
        },
      });
      console.log(`  [wrangler] finished in ${result.turns} turn(s)`);

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.finalText, is_error: false });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

await runParent(
  "The workspace has two people's incident-retro notes, draft-a.md and draft-b.md, that need to be merged " +
    "into merged.md, with the two originals cleaned up afterward. Get that done and tell me what the merged " +
    "file ended up covering.",
);
