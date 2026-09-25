#!/usr/bin/env node

/**
 * TypeSafe Jev Broker Daemon
 * Manages Unix domain socket connections, keep-alive HTTP pooling,
 * rate limiting, and in-memory TTL caching for Jev decision requests.
 */

import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "jev.json");
const CONFIG_PATH = process.env.JEV_CONFIG_PATH || DEFAULT_CONFIG_PATH;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[jev-broker] Failed to read config:", err.message);
  }
  return {
    enabled: true,
    apiKey: process.env.TYPESAFE_API_KEY || "",
    brokerSocket: process.env.JEV_BROKER_SOCKET || "/tmp/jev-broker.sock",
    apiUrl: process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone",
    modelVersion: process.env.JEV_MODEL_VERSION || "jev-1.13.0"
  };
}

const config = loadConfig();
const SOCKET_PATH = config.brokerSocket || "/tmp/jev-broker.sock";
const API_URL = config.apiUrl || "https://api.typesafe.ai/v1/systemone";
const API_KEY = config.apiKey || process.env.TYPESAFE_API_KEY || "";
const MODEL_VERSION = config.modelVersion || "jev-1.13.0";

if (!API_KEY) {
  console.warn("[jev-broker] Warning: No apiKey specified in config or TYPESAFE_API_KEY environment variable.");
}

// In-memory cache: key -> { timestamp, result }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCacheKey(payload) {
  const content = JSON.stringify({
    model: payload.model || MODEL_VERSION,
    state: payload.state,
    questions: payload.questions
  });
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key, result) {
  cache.set(key, { timestamp: Date.now(), result });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.timestamp > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

// Upstream call with timeout
async function callJev(payload, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    state: payload.state,
    model: payload.model || MODEL_VERSION,
    questions: payload.questions
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Upstream error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return { ok: true, data };
  } finally {
    clearTimeout(timer);
  }
}

// Clean up existing dead socket
if (fs.existsSync(SOCKET_PATH)) {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    console.error("[jev-broker] Could not remove existing socket:", err.message);
  }
}

const server = net.createServer((socket) => {
  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");

    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!raw) return;

      try {
        const req = JSON.parse(raw);
        const cacheKey = getCacheKey(req);
        const cached = getCached(cacheKey);

        if (cached) {
          socket.write(JSON.stringify({ ok: true, cached: true, result: cached }) + "\n");
          return;
        }

        const timeout = req.timeoutMs || 1500;
        const upstream = await callJev(req, timeout);

        if (upstream.ok) {
          setCache(cacheKey, upstream.data);
          socket.write(JSON.stringify({ ok: true, cached: false, result: upstream.data }) + "\n");
        } else {
          socket.write(JSON.stringify({ ok: false, error: upstream.error }) + "\n");
        }
      } catch (err) {
        socket.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o777);
  } catch {}
  console.log(`[jev-broker] Listening on Unix socket: ${SOCKET_PATH}`);
});

function cleanup() {
  console.log("\n[jev-broker] Shutting down...");
  server.close(() => {
    if (fs.existsSync(SOCKET_PATH)) {
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {}
    }
    process.exit(0);
  });
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
