# TypeSafe Jev Plugin for OpenCode & OmO

> **Intelligent System One decision gating and aggressive token saving for OpenCode, OhMyOpenCode (OmO), and FuelIX.**

TypeSafe Jev is a fast, calibrated decision model ("System One"). It does not generate text or code. It evaluates software state and answers typed questions (`Choice`, `Score`, `Noul`) in ~250 ms.

This plugin connects OpenCode to Jev to automate agent infrastructure decisions, optimize model parameters, and aggressively reduce token consumption across all session turns.

---

## ⚡ Key Capabilities & Token Savings

| Capability | Hook Point | Measured Token Savings |
|---|---|---|
| **Dynamic Reasoning Budget Scaling** | `chat.params` | **1,000 – 6,000 output tokens / turn** |
| **Test Failure Log Compression** | `tool.execute.after` | **~4,000 tokens / test run** |
| **Skill Catalog Pruning** | `experimental.chat.system.transform` | **~2,300 tokens / turn** |
| **Extractive Context Garbage Collection** | `experimental.chat.messages.transform` | **~4,000 tokens / session** |
| **Subagent Category Routing** | `tool.execute.before` | **300 – 800 tokens / task call** |
| **Command Safety Pre-Check** | `tool.execute.before` | **Blocks destructive bash actions** |

---

## 🛠️ Architecture

```
OpenCode / OmO / Subagents
         │
         ▼ (Lifecycle hook intercepts before/after call)
Local Jev Broker Daemon (`/tmp/jev-broker.sock`)
         │  ├── 60s In-Memory Cache (sub-2ms response)
         │  └── Connection Pool & Limiter
         ▼
TypeSafe API (`https://api.typesafe.ai/v1/systemone`)
         │
         ▼ (Returns typed answer + probabilities + confidence)
Action Applied (Prune prompt, adjust budget, route category)
```

- **Local Broker**: A lightweight sidecar process listening on `/tmp/jev-broker.sock`. It caches repeated decisions in memory (returning in **2 ms**), pools HTTP connections, and auto-spawns on demand.
- **Fail-Safe Polarity**:
  - **Safety**: Fail-closed (suspicious or failed commands always escalate to user review).
  - **Routing & Loops**: Fail-open (falls back to current agent behavior if Jev is unavailable).
- **Zero Disruption**: Real tests and compilers always run. Jev replaces LLM judgment, never verification.

---

## 🚀 Installation

### Option A: Prompt for AI Coding Agents

Copy and paste this instruction into OpenCode or any coding agent:

```text
Install and configure the opencode-jev-plugin:
1. Clone https://github.com/fsodanogm2dev/opencode-jev-plugin into ~/.config/opencode/plugins/opencode-jev-plugin
2. Copy ~/.config/opencode/plugins/opencode-jev-plugin/jev.json.example to ~/.config/opencode/jev.json
3. Set your TypeSafe API key in ~/.config/opencode/jev.json under "apiKey" (or export TYPESAFE_API_KEY)
4. Register "~/.config/opencode/plugins/opencode-jev-plugin/src/plugin.js" in the "plugin" array of ~/.config/opencode/opencode.json
5. Start the background broker with: nohup node ~/.config/opencode/plugins/opencode-jev-plugin/src/broker.js </dev/null >/tmp/jev-broker.log 2>&1 &
6. Verify live telemetry by inspecting ~/.local/share/jev/telemetry.jsonl
```

---

### Option B: Manual Setup for Humans

#### 1. Clone the repository
```bash
mkdir -p ~/.config/opencode/plugins
cd ~/.config/opencode/plugins
git clone https://github.com/fsodanogm2dev/opencode-jev-plugin.git
```

#### 2. Configure your API key
```bash
cp opencode-jev-plugin/jev.json.example ~/.config/opencode/jev.json
```

Edit `~/.config/opencode/jev.json` and insert your TypeSafe API key:
```json
{
  "enabled": true,
  "apiKey": "your-typesafe-api-key",
  "modelVersion": "jev-1.13.0",
  "brokerSocket": "/tmp/jev-broker.sock"
}
```

#### 3. Register the plugin in `opencode.json`
Add the plugin path to the `"plugin"` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "oh-my-openagent@5.0.0-beta.89",
    "@openchamber/opencode-claude@0.14.0",
    "/Users/YOUR_USER/.config/opencode/plugins/opencode-jev-plugin/src/plugin.js"
  ]
}
```

#### 4. Start the background broker
```bash
nohup node ~/.config/opencode/plugins/opencode-jev-plugin/src/broker.js </dev/null >/tmp/jev-broker.log 2>&1 &
```

*(Note: The plugin will also automatically start the broker if the socket is ever missing).*

---

## ⚙️ Configuration Reference (`~/.config/opencode/jev.json`)

Each decision point supports three modes:
- `"off"`: Completely disabled.
- `"shadow"`: Evaluates and logs decisions to telemetry, but does not alter agent behavior.
- `"enforce"`: Actively modifies parameters, prompts, or categories.

```json
{
  "enabled": true,
  "apiKey": "${TYPESAFE_API_KEY}",
  "modelVersion": "jev-1.13.0",
  "brokerSocket": "/tmp/jev-broker.sock",
  "points": {
    "categoryRouting": {
      "mode": "enforce",
      "timeoutMs": 800,
      "confidenceThreshold": 0.75
    },
    "safetyPreCheck": {
      "mode": "enforce",
      "timeoutMs": 1500,
      "riskThreshold": 0.20
    },
    "testCompression": {
      "mode": "enforce",
      "timeoutMs": 2500,
      "maxRawLength": 1200
    },
    "reasoningBudget": {
      "mode": "enforce",
      "timeoutMs": 800,
      "minTokens": 1024,
      "standardTokens": 4096,
      "complexTokens": 16384,
      "maxTokens": 32768
    },
    "skillPruning": {
      "mode": "enforce",
      "timeoutMs": 800,
      "maxSkills": 3
    },
    "contextGC": {
      "mode": "enforce",
      "timeoutMs": 2000,
      "relevanceThreshold": 0.35,
      "minContextChars": 20000
    }
  }
}
```

---

## 📊 Live Telemetry

Monitor Jev decisions, latency, and token savings in real time:

```bash
tail -f ~/.local/share/jev/telemetry.jsonl
```

Example telemetry log entries:

```json
{"timestamp":"2026-09-25T21:24:22.557Z","point":"skillPruning","mode":"enforce","totalSkills":13,"selectedSkill":"skill-creator","savedTokensEstimate":2355,"latencyMs":1}
{"timestamp":"2026-09-25T20:28:33.763Z","point":"testCompression","mode":"enforce","originalChars":15500,"savedTokensEstimate":3675,"errorType":"assertion","isFlaky":0.05,"latencyMs":357}
{"timestamp":"2026-09-25T20:28:34.070Z","point":"reasoningBudget","mode":"enforce","userQuery":"Design distributed consensus protocol...","reasoningScore":3,"allocatedBudget":32768,"latencyMs":305}
{"timestamp":"2026-09-25T20:29:42.707Z","point":"categoryRouting","mode":"enforce","originalCategory":"quick","jevChoice":"deep-low","confidence":1,"cached":false,"latencyMs":243}
```

---

## 🔒 Security & Privacy

1. **No Credentials in Git**: `.gitignore` strictly protects `.env`, `*.key`, and personal credentials.
2. **Local Caching**: Repeated identical queries never hit the external API. They resolve in memory on localhost in 2 ms.
3. **Hard Vetoes**: Destructive actions (`rm -rf`, force-push, drop database) cannot be overridden by model outputs.

---

## 📄 License

MIT © [Federico Sodano](https://github.com/fsodanogm2dev)
