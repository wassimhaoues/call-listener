import test from "node:test";
import assert from "node:assert/strict";
import { ChatOpenRouter } from "@langchain/openrouter";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

test("LangGraph compiles and invokes a minimal typed workflow", async () => {
  const State = Annotation.Root({
    turnCount: Annotation({ default: () => 0 }),
  });
  const graph = new StateGraph(State)
    .addNode("increment", (state) => ({ turnCount: state.turnCount + 1 }))
    .addEdge(START, "increment")
    .addEdge("increment", END)
    .compile();

  const result = await graph.invoke({ turnCount: 2 });
  assert.equal(result.turnCount, 3);
});

test("OpenRouter model configuration can be created without a network call", () => {
  const settings = z.object({
    apiKey: z.string().min(1),
    model: z.string().min(1),
  }).parse({
    apiKey: "test-key-not-used-for-network-calls",
    model: "openai/gpt-4.1-mini",
  });

  const model = new ChatOpenRouter(settings);
  assert.equal(model.model, settings.model);
});
