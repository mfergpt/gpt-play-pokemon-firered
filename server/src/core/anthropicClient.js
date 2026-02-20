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

// --- Bankr LLM Gateway Fallback ---
const BANKR_LLM_URL = "https://llm.bankr.bot";
const BANKR_API_KEY = "bk_PDCA77XR8FPHGZB66XSPTMLLT4HEKUPH";

let bankrClientInstance = null;

function getBankrClient() {
  if (!bankrClientInstance) {
    bankrClientInstance = new Anthropic({
      apiKey: BANKR_API_KEY,
      baseURL: BANKR_LLM_URL,
    });
  }
  return bankrClientInstance;
}

// Bankr gateway uses different model IDs (dots instead of dashes, different versions)
const BANKR_MODEL_MAP = {
  "claude-sonnet-4-6": "claude-sonnet-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
};

function mapModelForBankr(model) {
  return BANKR_MODEL_MAP[model] || "claude-sonnet-4.5"; // Default to sonnet
}

// Track which client is active: "primary" or "bankr"
let activeProvider = "primary";
let primaryFailedAt = 0;
const PRIMARY_RETRY_INTERVAL_MS = 5 * 60 * 1000; // Retry primary every 5 minutes

/**
 * Get the best available client, with automatic fallback.
 * On auth/rate errors, switches to bankr. Periodically retries primary.
 */
function getClientWithFallback() {
  // If primary failed recently, use bankr but periodically retry primary
  if (activeProvider === "bankr") {
    const elapsed = Date.now() - primaryFailedAt;
    if (elapsed > PRIMARY_RETRY_INTERVAL_MS) {
      console.log("[Fallback] Retrying primary Anthropic client...");
      activeProvider = "primary";
    } else {
      return { client: getBankrClient(), provider: "bankr" };
    }
  }

  try {
    return { client: getClient(), provider: "primary" };
  } catch (err) {
    console.warn(`[Fallback] Primary client failed: ${err.message}. Switching to Bankr LLM gateway.`);
    activeProvider = "bankr";
    primaryFailedAt = Date.now();
    return { client: getBankrClient(), provider: "bankr" };
  }
}

/**
 * Call this on API errors to trigger fallback.
 * Returns true if fallback is available (caller should retry).
 */
function handleApiError(err) {
  const status = err?.status || err?.error?.status;
  const errType = err?.error?.error?.type || err?.error?.type || "";
  
  // Fallback on auth failures, rate limits, or credit exhaustion
  const shouldFallback = (
    status === 401 || status === 403 || status === 429 ||
    errType === "rate_limit_error" ||
    errType === "authentication_error" ||
    errType === "permission_error" ||
    (err.message && (err.message.includes("credit") || err.message.includes("rate_limit") || err.message.includes("auth")))
  );

  if (shouldFallback && activeProvider === "primary") {
    console.warn(`[Fallback] API error (${status || errType}): switching to Bankr LLM gateway.`);
    activeProvider = "bankr";
    primaryFailedAt = Date.now();
    return true; // Caller should retry with new client
  }
  return false; // No fallback available or already on bankr
}

function getActiveProvider() {
  return activeProvider;
}

module.exports = { getClient, getAuthToken, createAnthropicClient, getBankrClient, getClientWithFallback, handleApiError, getActiveProvider, mapModelForBankr };
