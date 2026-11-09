import { pathToFileURL } from "node:url";
import { createInterpreterFromEnv, OpenAIInterpreter } from "./openai-interpreter.js";

async function main(): Promise<void> {
  const interpreter = createInterpreterFromEnv();
  if (!(interpreter instanceof OpenAIInterpreter)) {
    console.error("Live smoke test not run: set OPENAI_API_KEY and OPENAI_MODEL.");
    process.exitCode = 1;
    return;
  }

  const proposal = await interpreter.interpret("Release shipment for ORD-100");
  console.log(JSON.stringify(proposal));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "live smoke test failed");
    process.exitCode = 1;
  });
}
