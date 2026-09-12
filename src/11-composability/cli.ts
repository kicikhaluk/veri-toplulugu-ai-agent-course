import "dotenv/config";
import * as path from "node:path";
import { runWrangler } from "./wrangler.js";

// Every prior module hardcoded its task and its workspace as constants in
// main.ts. A real CLI entry point takes both as arguments instead — this is
// the whole shift this module is about, not new agent logic.
function parseArgs(argv: string[]): { workspace: string; task: string; maxTurns?: number } {
  const args = [...argv];
  let workspace = path.resolve(import.meta.dirname, "workspace");
  let maxTurns: number | undefined;
  const rest: string[] = [];

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--workspace" || arg === "-w") {
      const value = args.shift();
      if (!value) throw new Error("--workspace requires a directory argument");
      workspace = path.resolve(value);
    } else if (arg === "--max-turns") {
      const value = args.shift();
      if (!value) throw new Error("--max-turns requires a number");
      maxTurns = Number(value);
    } else {
      rest.push(arg);
    }
  }

  const task = rest.join(" ").trim();
  if (!task) {
    throw new Error('Usage: npx tsx cli.ts [--workspace <dir>] [--max-turns <n>] "<task>"');
  }
  return { workspace, task, maxTurns };
}

const { workspace, task, maxTurns } = parseArgs(process.argv.slice(2));

console.log(`workspace: ${workspace}`);
console.log(`task: ${task}\n`);

const result = await runWrangler(workspace, task, {
  maxTurns,
  onTurn: (response) => {
    for (const block of response.content) {
      if (block.type === "text") console.log(`text: ${block.text}`);
      else if (block.type === "tool_use") console.log(`tool_use: ${block.name}(${JSON.stringify(block.input)})`);
    }
  },
});

console.log(`\n--- done in ${result.turns} turn(s) ---`);
console.log(result.finalText);
