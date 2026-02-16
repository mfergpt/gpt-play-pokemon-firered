const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const CLAUDE_CODE_VERSION = "2.1.44";

// Read the OAuth token from OpenClaw's auth-profiles (auto-refreshed by OpenClaw)
const AUTH_PROFILES_PATH = path.join(
  process.env.HOME || "/Users/mfergpt",
  ".openclaw/agents/main/agent/auth-profiles.json"
);

let cachedToken = null;
let cachedTokenMtime = 0;

function getAuthToken() {
  // Check env first
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return process.env.ANTHROPIC_AUTH_TOKEN;
  }

  // Read from OpenClaw auth-profiles (with mtime cache)
  try {
    const stat = fs.statSync(AUTH_PROFILES_PATH);
    if (stat.mtimeMs !== cachedTokenMtime || !cachedToken) {
      const data = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, "utf8"));
      const profile = data.profiles?.["anthropic:default"];
      if (profile?.token) {
        cachedToken = profile.token;
        cachedTokenMtime = stat.mtimeMs;
      }
    }
  } catch (err) {
    console.error("[Anthropic] Failed to read auth token:", err.message);
  }

  if (!cachedToken) {
    throw new Error(
      "No Anthropic auth token found. Set ANTHROPIC_AUTH_TOKEN or ensure OpenClaw auth-profiles.json exists."
    );
  }
  return cachedToken;
}

function createAnthropicClient() {
  const token = getAuthToken();
  return new Anthropic({
    apiKey: null,
    authToken: token,
    defaultHeaders: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14`,
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      "x-app": "cli",
    },
    dangerouslyAllowBrowser: true,
  });
}

// Lazy singleton that refreshes when token changes
let clientInstance = null;
let clientToken = null;

function getClient() {
  const token = getAuthToken();
  if (!clientInstance || token !== clientToken) {
    clientInstance = createAnthropicClient();
    clientToken = token;
  }
  return clientInstance;
}

module.exports = { getClient, getAuthToken, createAnthropicClient };
