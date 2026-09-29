/**
 * TypeSafe Jev OpenCode Plugin
 * Provides typed decision routing, command safety, test log compression,
 * dynamic reasoning budget scaling, skill pruning, and context garbage collection.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "jev.json");
const CONFIG_PATH = process.env.JEV_CONFIG_PATH || DEFAULT_CONFIG_PATH;
const TELEMETRY_DIR = path.join(os.homedir(), ".local", "share", "jev");
const TELEMETRY_PATH = path.join(TELEMETRY_DIR, "telemetry.jsonl");
const BACKUP_TELEMETRY_PATH = path.join(TELEMETRY_DIR, "telemetry.jsonl.1");
const MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch (err) {
    console.error("[jev-plugin] Error reading config:", err.message);
  }
  return { enabled: true, points: {} };
}

function logTelemetry(entry) {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }

    if (fs.existsSync(TELEMETRY_PATH)) {
      const stats = fs.statSync(TELEMETRY_PATH);
      if (stats.size > MAX_TELEMETRY_BYTES) {
        if (fs.existsSync(BACKUP_TELEMETRY_PATH)) {
          fs.unlinkSync(BACKUP_TELEMETRY_PATH);
        }
        fs.renameSync(TELEMETRY_PATH, BACKUP_TELEMETRY_PATH);
      }
    }

    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(TELEMETRY_PATH, line, "utf8");
  } catch (err) {
    // Non-blocking
  }
}

async function callBroker(payload, timeoutMs = 1200) {
  const config = loadConfig();
  const socketPath = config.brokerSocket || process.env.JEV_BROKER_SOCKET || "/tmp/jev-broker.sock";

  if (!fs.existsSync(socketPath)) {
    try {
      // Auto-start broker if not running
      const brokerScript = path.join(path.dirname(new URL(import.meta.url).pathname), "broker.js");
      const child = child_process.spawn("node", [brokerScript], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 80));
        if (fs.existsSync(socketPath)) break;
      }
    } catch {}
  }

  if (!fs.existsSync(socketPath)) {
    return { ok: false, error: "broker_offline" };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify({ ...payload, timeoutMs }) + "\n");
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve({ ok: false, error: "timeout" });
      }
    }, timeoutMs);

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.end();
          try {
            const parsed = JSON.parse(buffer.slice(0, newlineIdx).trim());
            resolve(parsed);
          } catch (e) {
            resolve({ ok: false, error: "invalid_response" });
          }
        }
      }
    });

    client.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

// 1. Subagent Category Routing
async function handleCategoryRouting(input, output, config) {
  const pointConfig = config.points?.categoryRouting;
  if (!pointConfig || pointConfig.mode === "off") return;

  const prompt = output.args?.prompt;
  if (!prompt || typeof prompt !== "string") return;

  const originalCategory = output.args.category || "unspecified";
  const start = Date.now();

  const questions = {
    category: {
      type: "choice",
      instructions: "Which execution category is best for this coding task?",
      criteria: {
        "quick": "Small single-file edits, typo fixes, narrow obvious modifications",
        "deep-low": "Backend implementation, multi-step logic, algorithms, bug fixes",
        "ultrabrain": "Hard architectural decisions, complex multi-system debugging",
        "visual-engineering": "Frontend, UI styling, components, and layout",
        "writing": "Documentation, prose, README, or technical explanations"
      }
    }
  };

  const res = await callBroker({ state: prompt.slice(0, 4000), questions }, pointConfig.timeoutMs || 800);
  const latencyMs = Date.now() - start;

  if (res.ok && res.result?.answers?.category) {
    const choiceObj = res.result.answers.category;
    const chosenCategory = choiceObj.choice;
    const confidence = choiceObj.confidence ?? 0;

    logTelemetry({
      point: "categoryRouting",
      mode: pointConfig.mode,
      taskPrompt: prompt.slice(0, 200),
      originalCategory,
      jevChoice: chosenCategory,
      confidence,
      cached: res.cached ?? false,
      latencyMs
    });

    if (pointConfig.mode === "enforce") {
      const threshold = pointConfig.confidenceThreshold ?? 0.75;
      if (confidence >= threshold && chosenCategory) {
        output.args.category = chosenCategory;
      }
    }
  }
}

// 2. Safety Pre-Check
async function handleSafetyPreCheck(input, output, config) {
  const pointConfig = config.points?.safetyPreCheck;
  if (!pointConfig || pointConfig.mode === "off") return;

  const command = output.args?.command;
  if (!command || typeof command !== "string") return;

  const start = Date.now();
  const questions = {
    is_destructive: {
      type: "noul",
      instructions: "Does this bash command permanently delete files, drop databases, or cause irreversible loss?",
      criteria: {
        true: "Command deletes files, truncates tables, drops databases, or reformats disks",
        false: "Command is non-destructive, read-only, informational, or safe modification"
      }
    }
  };

  const res = await callBroker({ state: command, questions }, pointConfig.timeoutMs || 1500);
  const latencyMs = Date.now() - start;

  if (res.ok && res.result?.answers?.is_destructive) {
    const noulVal = res.result.answers.is_destructive.noul ?? 0;

    logTelemetry({
      point: "safetyPreCheck",
      mode: pointConfig.mode,
      command: command.slice(0, 200),
      destructiveProbability: noulVal,
      cached: res.cached ?? false,
      latencyMs
    });

    if (pointConfig.mode === "enforce") {
      const threshold = pointConfig.riskThreshold ?? 0.20;
      if (noulVal > threshold) {
        output.requireConfirmation = true;
      }
    }
  }
}

// 3. Test Failure Log Compression
async function handleTestFailureCompression(input, output, config) {
  const pointConfig = config.points?.testCompression;
  if (!pointConfig || pointConfig.mode === "off") return;

  if (input.tool !== "bash" || typeof output.output !== "string") return;

  const text = output.output;
  const maxLen = pointConfig.maxRawLength || 1200;
  if (text.length <= maxLen) return;

  const isTestOrBuildFailure = /(FAIL|AssertionError|Test Suites:.*failed|tests failed|FAILED \(failures=|FAIL:|npm ERR!|cargo test.*failed|pytest.*failed|error\[E\d+\]:)/i.test(text);
  if (!isTestOrBuildFailure) return;

  const start = Date.now();
  const questions = {
    error_type: {
      type: "choice",
      instructions: "What is the primary root cause category of this test or build failure?",
      criteria: {
        "assertion": "Assertion or unit test failure (expected value did not match received)",
        "syntax": "Syntax error, type checking error, or compilation failure",
        "environment": "Missing module, command not found, or environment/configuration issue",
        "timeout": "Test run timed out or stalled"
      }
    },
    is_flaky: {
      type: "noul",
      instructions: "Is this failure likely caused by a network timeout, race condition, or port collision rather than bad code logic?",
      criteria: {
        true: "Transient failure, socket timeout, port busy, or flaky timing",
        false: "Legitimate code logic bug or assertion error"
      }
    }
  };

  const sample = text.slice(0, 3000) + "\n...[middle omitted]...\n" + text.slice(-3000);
  const res = await callBroker({ state: sample, questions }, pointConfig.timeoutMs || 2500);
  const latencyMs = Date.now() - start;

  if (res.ok && res.result?.answers?.error_type) {
    const errorType = res.result.answers.error_type.choice;
    const errorConf = res.result.answers.error_type.confidence ?? 0;
    const isFlakyProb = res.result.answers.is_flaky?.noul ?? 0;

    const logId = input.callID || `test-${Date.now()}`;
    const logFilePath = path.join("/tmp", `opencode-test-${logId}.log`);
    try {
      fs.writeFileSync(logFilePath, text, "utf8");
    } catch {}

    const originalTokens = Math.round(text.length / 4);

    if (pointConfig.mode === "enforce") {
      const summary = [
        `[JEV TEST FAILURE COMPRESSION - Saved ~${originalTokens} tokens]`,
        `Root Cause: ${errorType.toUpperCase()} (confidence: ${errorConf})`,
        `Flaky Probability: ${isFlakyProb.toFixed(2)}`,
        `Full raw log saved to: ${logFilePath}`,
        `--- Failure Excerpt ---`,
        text.slice(0, 800).trim(),
        `\n[... Remaining ${text.length - 800} characters written to ${logFilePath}. Use Read tool if deeper stack trace is needed.]`
      ].join("\n");

      output.output = summary;
    }

    logTelemetry({
      point: "testCompression",
      mode: pointConfig.mode,
      originalChars: text.length,
      savedTokensEstimate: Math.max(0, originalTokens - 200),
      errorType,
      isFlaky: isFlakyProb,
      latencyMs
    });
  }
}

// 4. Dynamic Reasoning Budget Scaling
async function handleReasoningBudget(input, output, config) {
  const pointConfig = config.points?.reasoningBudget;
  if (!pointConfig || pointConfig.mode === "off") return;

  const userQuery = input.message?.summary?.body || input.message?.parts?.find(p => p.type === "text")?.text || "";
  if (!userQuery || userQuery.length < 5) return;

  const start = Date.now();
  const questions = {
    reasoning_depth: {
      type: "score",
      instructions: "Score the cognitive reasoning needed for this user turn",
      criteria: [
        "Mechanical edit, typo, simple file read, status check, or trivial instruction",
        "Standard coding, minor bug fix, single component change, routine task",
        "Multi-module refactor, algorithm implementation, or complex debugging",
        "Novel architectural design, security audit, formal verification, or hard logic"
      ]
    }
  };

  const res = await callBroker({ state: userQuery.slice(0, 2000), questions }, pointConfig.timeoutMs || 800);
  const latencyMs = Date.now() - start;

  if (res.ok && res.result?.answers?.reasoning_depth) {
    const scoreVal = res.result.answers.reasoning_depth.score ?? 1.0;
    let targetTokens = 4096;

    if (scoreVal < 0.75) {
      targetTokens = pointConfig.minTokens || 1024;
    } else if (scoreVal < 1.75) {
      targetTokens = pointConfig.standardTokens || 4096;
    } else if (scoreVal < 2.75) {
      targetTokens = pointConfig.complexTokens || 16384;
    } else {
      targetTokens = pointConfig.maxTokens || 32768;
    }

    if (pointConfig.mode === "enforce") {
      output.options = output.options || {};
      output.options.reasoningBudget = targetTokens;
      output.options.thinking = { type: "enabled", budgetTokens: targetTokens };
    }

    logTelemetry({
      point: "reasoningBudget",
      mode: pointConfig.mode,
      userQuery: userQuery.slice(0, 150),
      reasoningScore: scoreVal,
      allocatedBudget: targetTokens,
      latencyMs
    });
  }
}

// 5. Dynamic Skill Catalog Pruning
async function handleSkillPruning(input, output, config) {
  const pointConfig = config.points?.skillPruning;
  if (!pointConfig || pointConfig.mode === "off") return;

  if (!Array.isArray(output.system)) return;

  const skillIdx = output.system.findIndex(s => s && s.includes("<available_skills>"));
  if (skillIdx === -1) return;

  const skillBlock = output.system[skillIdx];
  const maxSkills = pointConfig.maxSkills || 3;

  const matches = [...skillBlock.matchAll(/<name>([^<]+)<\/name>/g)].map(m => m[1].trim());
  if (matches.length <= maxSkills) return;

  const start = Date.now();
  const criteria = {};
  matches.forEach(name => {
    criteria[name] = `Skill ${name}`;
  });

  const questions = {
    top_skill: {
      type: "choice",
      instructions: "Which single skill from this list is most relevant for the developer session?",
      criteria
    }
  };

  const res = await callBroker({ state: matches.join(", "), questions }, pointConfig.timeoutMs || 800);
  const latencyMs = Date.now() - start;

  if (res.ok && res.result?.answers?.top_skill) {
    const chosen = res.result.answers.top_skill.choice;
    const originalTokens = Math.round(skillBlock.length / 4);

    if (pointConfig.mode === "enforce" && chosen) {
      const pattern = new RegExp(`<skill>\\s*<name>(?!${chosen}|customize-opencode)[^<]+<\\/name>[\\s\\S]*?<\\/skill>`, "g");
      output.system[skillIdx] = skillBlock.replace(pattern, "");
      const newTokens = Math.round(output.system[skillIdx].length / 4);

      logTelemetry({
        point: "skillPruning",
        mode: pointConfig.mode,
        totalSkills: matches.length,
        selectedSkill: chosen,
        savedTokensEstimate: Math.max(0, originalTokens - newTokens),
        latencyMs
      });
    }
  }
}

// 6. Extractive Context Garbage Collection
async function handleContextGC(input, output, config) {
  const pointConfig = config.points?.contextGC;
  if (!pointConfig || pointConfig.mode === "off") return;

  if (!Array.isArray(output.messages)) return;

  let totalChars = 0;
  for (const msg of output.messages) {
    if (msg.parts) {
      for (const p of msg.parts) {
        if (p.text) totalChars += p.text.length;
        if (p.output) totalChars += p.output.length;
      }
    }
  }

  const minChars = pointConfig.minContextChars || 20000;
  if (totalChars < minChars) return;

  const start = Date.now();
  let prunedParts = 0;
  let savedChars = 0;

  const eligibleMessages = output.messages.slice(0, -4);

  for (const msg of eligibleMessages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type === "tool" && part.output && part.output.length > 1000) {
        savedChars += (part.output.length - 200);
        part.output = `[Jev Pruner: Verbose tool output truncated (${part.output.length} chars). Result archived in session.]`;
        prunedParts++;
      }
    }
  }

  const latencyMs = Date.now() - start;
  if (prunedParts > 0) {
    logTelemetry({
      point: "contextGC",
      mode: pointConfig.mode,
      prunedParts,
      savedTokensEstimate: Math.round(savedChars / 4),
      latencyMs
    });
  }
}

export default {
  id: "jev-orchestrator",
  server() {
    return {
      "tool.execute.before": async (input, output) => {
        try {
          const config = loadConfig();
          if (!config.enabled) return;

          if (input.tool === "task") {
            await handleCategoryRouting(input, output, config);
          } else if (input.tool === "bash") {
            await handleSafetyPreCheck(input, output, config);
          }
        } catch (err) {
          console.error("[jev-plugin] Hook error (before):", err.message);
        }
      },

      "tool.execute.after": async (input, output) => {
        try {
          const config = loadConfig();
          if (!config.enabled) return;

          await handleTestFailureCompression(input, output, config);
        } catch (err) {
          console.error("[jev-plugin] Hook error (after):", err.message);
        }
      },

      "chat.params": async (input, output) => {
        try {
          const config = loadConfig();
          if (!config.enabled) return;

          await handleReasoningBudget(input, output, config);
        } catch (err) {
          console.error("[jev-plugin] Hook error (chat.params):", err.message);
        }
      },

      "experimental.chat.system.transform": async (input, output) => {
        try {
          const config = loadConfig();
          if (!config.enabled) return;

          await handleSkillPruning(input, output, config);
        } catch (err) {
          console.error("[jev-plugin] Hook error (system.transform):", err.message);
        }
      },

      "experimental.chat.messages.transform": async (input, output) => {
        try {
          const config = loadConfig();
          if (!config.enabled) return;

          await handleContextGC(input, output, config);
        } catch (err) {
          console.error("[jev-plugin] Hook error (messages.transform):", err.message);
        }
      }
    };
  },
  setup(ctx) {}
};
