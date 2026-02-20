const path = require("path");

// `__dirname` points to `server/src`; ROOT_DIR is `server/`
const ROOT_DIR = path.join(__dirname, "..");

const config = {
  wsPort: Number(process.env.WS_PORT || 9885),

  // --- Provider Selection ---
  // Set USE_ANTHROPIC=1 to use Anthropic via setup-token instead of OpenAI
  useAnthropic: process.env.USE_ANTHROPIC === "1" || process.env.USE_ANTHROPIC === "true",

  // --- OpenAI Configuration ---
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-5.2",

    // Reasoning efforts — dynamic getters that return xhigh for gpt-5.2, high otherwise
    get reasoningEffort() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT, "high"); },
    get reasoningEffortBattle() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT_BATTLE, "high"); },
    get reasoningEffortDialog() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT_DIALOG, "high"); },
    get reasoningEffortCriticism() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT_CRITICISM, "high"); },
    get reasoningEffortSummary() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT_SUMMARY, "xhigh"); },
    get reasoningEffortPathfinding() { return this._effortFor(process.env.OPENAI_REASONING_EFFORT_PATHFINDING, "high"); },
    _effortFor(envVal, fullModelDefault) {
      const XHIGH_MODELS = ["gpt-5.2", "gpt-5.1", "gpt-5"];
      const supportsXhigh = XHIGH_MODELS.includes(this.model);
      if (envVal) {
        // If env explicitly set xhigh but model doesn't support it, downgrade
        return (envVal === "xhigh" && !supportsXhigh) ? "high" : envVal;
      }
      // Default: use xhigh for full models, high for others
      return (fullModelDefault === "xhigh" && !supportsXhigh) ? "high" : fullModelDefault;
    },

    modelPathFinding: process.env.OPENAI_MODEL_PATHFINDING || "gpt-5.2",
    reasoningSummary: process.env.OPENAI_REASONING_SUMMARY || "auto",

    tokenLimit: Number(process.env.OPENAI_TOKEN_LIMIT || 150000),
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 15 * 60 * 1000),
    service_tier: process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSelfCriticism:
      process.env.OPENAI_SERVICE_TIER_SELF_CRITICISM || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSummary: process.env.OPENAI_SERVICE_TIER_SUMMARY || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierPathfinding: process.env.OPENAI_SERVICE_TIER_PATHFINDING || "priority",
    maxOutputTokensMain: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_MAIN || 16000),
    maxOutputTokensSelfCriticism: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SELF_CRITICISM || 12000),
    maxOutputTokensSummary: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SUMMARY || 14000),
    maxOutputTokensSummaryRollup: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_SUMMARY_ROLLUP || 24000),

    tokenPrice: {
      "gpt-5.2": { input: 1.75, cached_input: 0.175, output: 14 },
      "gpt-5.1": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-5": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-4.1": { input: 2, cached_input: 0.5, output: 8 },
      "o4-mini": { input: 1.1, cached_input: 0.275, output: 4.4 },
      "o3": { input: 10, cached_input: 2.5, output: 40 },
    },
  },

  // --- Python Server Configuration (FireRed bridge) ---
  pythonServer: {
    baseUrl: process.env.PYTHON_BASE_URL || "http://127.0.0.1:8000",
    endpoints: {
      requestData: "/requestData",
      minimapSnapshot: "/minimapSnapshot",
      sendCommands: "/sendCommands",
      restartConsole: "/restartConsole",
    },
  },

  // --- Runtime Paths ---
  get dataDir() {
    return "gpt_data";
  },

  get promptsDir() {
    return path.join(ROOT_DIR, "prompts");
  },

  // --- File Paths ---
  paths: {
    baseDir: ROOT_DIR,

    get dataDir() {
      return config.dataDir;
    },

    get historySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "history.json");
    },
    get memorySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "memory.json");
    },
    get objectivesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "objectives.json");
    },
    get markersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "markers.json");
    },
    get countersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "counters.json");
    },
    get badgesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "badges_log.json");
    },
    get mapVisitsSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "map_visits.json");
    },
    get summariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "summaries.json");
    },
    get allSummariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "all_summaries.json");
    },
    get progressStepsFile() {
      return path.join(ROOT_DIR, config.dataDir, "progress_steps.json");
    },
    get lastVisitedMapsFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_visited_maps.json");
    },
    get gameDataJsonFile() {
      return path.join(ROOT_DIR, config.dataDir, "game_data.json");
    },
    get lastCriticismSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_criticism.txt");
    },
    get tokenUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "token_usage.json");
    },
    get timeUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "time_usage.json");
    },
    get lastUserInputTextSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_userInputText_prompt.txt");
    },
    get navigationPlanFile() {
      return path.join(ROOT_DIR, config.dataDir, "navigation_plan.json");
    },
  },

  // --- Prompt / Context Budgeting ---
  context: {
    // Set CONTEXT_INCLUDE_LIVE_CHAT=0 to disable streamer chat context in prompts.
    includeLiveChatInPrompt: process.env.CONTEXT_INCLUDE_LIVE_CHAT !== "0",
    // Set to 0 to disable external identity files in developer prompt.
    includeIdentityContextInDeveloperPrompt: process.env.CONTEXT_INCLUDE_IDENTITY !== "0",

    developerPromptIdentityMaxChars: Number(process.env.CONTEXT_DEVELOPER_IDENTITY_MAX_CHARS || 9000),
    userInputMaxChars: Number(process.env.CONTEXT_USER_INPUT_MAX_CHARS || 52000),
    userInputSummaryMaxChars: Number(process.env.CONTEXT_USER_INPUT_SUMMARY_MAX_CHARS || 26000),

    memoryMaxItems: Number(process.env.CONTEXT_MEMORY_MAX_ITEMS || 50),
    memoryItemValueMaxChars: Number(process.env.CONTEXT_MEMORY_VALUE_MAX_CHARS || 320),
    markersMaxMaps: Number(process.env.CONTEXT_MARKERS_MAX_MAPS || 8),
    markersMaxPerMap: Number(process.env.CONTEXT_MARKERS_MAX_PER_MAP || 24),
    liveChatMaxMessages: Number(process.env.CONTEXT_LIVE_CHAT_MAX_MESSAGES || 6),
    liveChatMaxMentions: Number(process.env.CONTEXT_LIVE_CHAT_MAX_MENTIONS || 3),
    liveChatMessageMaxChars: Number(process.env.CONTEXT_LIVE_CHAT_MESSAGE_MAX_CHARS || 220),
    useCompactDeveloperPromptForSummary: process.env.CONTEXT_COMPACT_DEVELOPER_PROMPT_SUMMARY === "1",
    useCompactDeveloperPromptForCriticism: process.env.CONTEXT_COMPACT_DEVELOPER_PROMPT_CRITICISM === "1",

    sectionMaxChars: {
      dialog_text: Number(process.env.CONTEXT_DIALOG_TEXT_MAX_CHARS || 1800),
      player_stats: Number(process.env.CONTEXT_PLAYER_STATS_MAX_CHARS || 11000),
      battle_state: Number(process.env.CONTEXT_BATTLE_STATE_MAX_CHARS || 4200),
      navigation_plan: Number(process.env.CONTEXT_NAV_PLAN_MAX_CHARS || 3200),
      objectives_section: Number(process.env.CONTEXT_OBJECTIVES_MAX_CHARS || 3200),
      memory: Number(process.env.CONTEXT_MEMORY_SECTION_MAX_CHARS || 9000),
      markers: Number(process.env.CONTEXT_MARKERS_SECTION_MAX_CHARS || 4200),
      visible_area: Number(process.env.CONTEXT_VISIBLE_AREA_MAX_CHARS || 7200),
      explored_map: Number(process.env.CONTEXT_EXPLORED_MAP_MAX_CHARS || 13000),
      live_chat: Number(process.env.CONTEXT_LIVE_CHAT_SECTION_MAX_CHARS || 1400),
    },

    summarySectionMaxChars: {
      dialog_text: Number(process.env.CONTEXT_SUMMARY_DIALOG_TEXT_MAX_CHARS || 1200),
      player_stats: Number(process.env.CONTEXT_SUMMARY_PLAYER_STATS_MAX_CHARS || 5600),
      battle_state: Number(process.env.CONTEXT_SUMMARY_BATTLE_STATE_MAX_CHARS || 2800),
      navigation_plan: Number(process.env.CONTEXT_SUMMARY_NAV_PLAN_MAX_CHARS || 2200),
      objectives_section: Number(process.env.CONTEXT_SUMMARY_OBJECTIVES_MAX_CHARS || 2100),
      memory: Number(process.env.CONTEXT_SUMMARY_MEMORY_SECTION_MAX_CHARS || 3400),
      markers: Number(process.env.CONTEXT_SUMMARY_MARKERS_SECTION_MAX_CHARS || 2200),
      visible_area: Number(process.env.CONTEXT_SUMMARY_VISIBLE_AREA_MAX_CHARS || 3600),
      explored_map: Number(process.env.CONTEXT_SUMMARY_EXPLORED_MAP_MAX_CHARS || 5200),
      live_chat: Number(process.env.CONTEXT_SUMMARY_LIVE_CHAT_SECTION_MAX_CHARS || 300),
    },

    toolResultStoreMaxChars: Number(process.env.CONTEXT_TOOL_RESULT_STORE_MAX_CHARS || 3200),
  },

  // --- History Processing Configuration ---
  history: {
    keepLastNToolPartialResults: 20,
    keepLastNToolFullResults: Number(process.env.HISTORY_KEEP_TOOL_FULL_RESULTS || 2),
    keepLastNUserMessagesWithMinimap: 1,
    keepLastNUserMessagesWithMemory: Number(process.env.HISTORY_KEEP_USER_MEMORY || 3),
    keepLastNUserMessagesWithViewMap: Number(process.env.HISTORY_KEEP_USER_VIEW_MAP || 2),
    keepLastNUserMessagesWithImages: Number(process.env.HISTORY_KEEP_USER_IMAGES || 2),
    keepLastNUserMessagesWithDetailedData: Number(process.env.HISTORY_KEEP_USER_DETAILED_DATA || 2),
    keepLastNUserMessagesWithPokedex: 1,
    userMessageMaxChars: Number(process.env.HISTORY_USER_MESSAGE_MAX_CHARS || 45000),
    toolResultKeepMaxChars: Number(process.env.HISTORY_TOOL_RESULT_KEEP_MAX_CHARS || 2600),
    toolResultDropMaxChars: Number(process.env.HISTORY_TOOL_RESULT_DROP_MAX_CHARS || 1200),
    toolResultDetailsMaxChars: Number(process.env.HISTORY_TOOL_RESULT_DETAILS_MAX_CHARS || 700),
    limitAssistantMessagesForSelfCriticism: 55,
    limitAssistantMessagesForSummary: 30,
  },

  // --- Tool Configuration ---
  tools: {
    strict: true,
  },

  // --- Loop Configuration ---
  loopDelayMs: 10000,
};

module.exports = { config };
