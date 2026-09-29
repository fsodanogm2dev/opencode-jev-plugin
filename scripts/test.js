import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-plugin-test-"));
const socketPath = path.join(directory, "broker.sock");
const configPath = path.join(directory, "jev.json");
const originalHome = os.homedir;
const originalConfig = process.env.JEV_CONFIG_PATH;

fs.writeFileSync(configPath, JSON.stringify({
  enabled: true,
  brokerSocket: socketPath,
  points: { reasoningBudget: { mode: "enforce", minTokens: 1024 } }
}));
os.homedir = () => directory;
process.env.JEV_CONFIG_PATH = configPath;

const broker = net.createServer((client) => {
  client.on("data", () => {
    client.end(JSON.stringify({ ok: true, result: { answers: { reasoning_depth: { score: 0.2 } } } }) + "\n");
  });
});

try {
  const { default: plugin } = await import("../src/plugin.js");
  assert.equal(plugin.id, "jev-orchestrator");
  const hooks = plugin.server();
  for (const name of ["tool.execute.before", "tool.execute.after", "chat.params", "experimental.chat.system.transform", "experimental.chat.messages.transform"]) {
    assert.equal(typeof hooks[name], "function");
  }

  await new Promise((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(socketPath, resolve);
  });

  async function reason(modelId, npm, options) {
    const output = { options };
    await hooks["chat.params"]({
      model: { api: { id: modelId, npm } },
      message: { parts: [{ type: "text", text: "Reply OK only." }] },
      sessionID: "test",
      agent: "build"
    }, output);
    return output.options;
  }

  const opus = await reason("claude-opus-5-5", "@ai-sdk/anthropic", {
    effort: "max",
    thinking: { type: "adaptive", display: "summarized" }
  });
  assert.deepEqual(opus.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(opus.effort, "max");
  assert.equal(opus.reasoningBudget, undefined);

  const sonnet = await reason("claude-sonnet-5-5", "@ai-sdk/anthropic", {});
  assert.deepEqual(sonnet.thinking, { type: "adaptive" });
  assert.equal(sonnet.effort, "low");
  assert.equal(sonnet.reasoningBudget, undefined);

  const legacy = await reason("claude-haiku-4-5", "@ai-sdk/anthropic", {});
  assert.deepEqual(legacy.thinking, { type: "enabled", budgetTokens: 1024 });
  assert.equal(legacy.reasoningBudget, 1024);

  const openai = await reason("gpt-6-luna", "@ai-sdk/openai", {});
  assert.deepEqual(openai.thinking, { type: "enabled", budgetTokens: 1024 });
  assert.equal(openai.reasoningBudget, 1024);

  console.log("Plugin hooks and provider reasoning passed.");
} finally {
  await new Promise((resolve) => broker.close(resolve));
  os.homedir = originalHome;
  if (originalConfig === undefined) delete process.env.JEV_CONFIG_PATH;
  else process.env.JEV_CONFIG_PATH = originalConfig;
  fs.rmSync(directory, { recursive: true, force: true });
}
