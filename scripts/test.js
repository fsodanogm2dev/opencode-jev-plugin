import plugin from "../src/plugin.js";
import assert from "node:assert";

console.log("Checking plugin export...");
assert.strictEqual(plugin.id, "jev-orchestrator");
const server = plugin.server();
const hooks = Object.keys(server);
console.log("Registered hooks:", hooks);

assert(hooks.includes("tool.execute.before"));
assert(hooks.includes("tool.execute.after"));
assert(hooks.includes("chat.params"));
assert(hooks.includes("experimental.chat.system.transform"));
assert(hooks.includes("experimental.chat.messages.transform"));

console.log("All plugin sanity checks passed.");
