import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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

  console.log("\n=== response ===");
  console.dir(response, { depth: null });

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

  console.log("\n=== tool_result(s) sent back ===");
  console.dir(toolResults, { depth: null });

  messages.push({ role: "user", content: toolResults });
}
