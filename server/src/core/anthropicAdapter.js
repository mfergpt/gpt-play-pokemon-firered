/**
 * Anthropic Adapter — drop-in replacement for openai.responses.create()
 * Translates OpenAI Responses API calls to Anthropic Messages API format.
 * Returns an async iterable of OpenAI-style events so the game loop needs minimal changes.
 */

const { getClient, getAuthToken } = require("./anthropicClient");

/**
 * Convert OpenAI-style input messages to Anthropic format.
 * - "developer" role → system parameter (extracted)
 * - "user"/"assistant" roles → messages array
 * - "function_call_output" → tool_result blocks
 */
function convertMessages(input) {
  let systemText = "";
  const messages = [];

  for (const msg of input) {
    if (!msg) continue;

    // Developer/system messages → system parameter
    if (msg.role === "developer" || msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b) => b.type === "input_text" || b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";
      if (text) systemText += (systemText ? "\n\n" : "") + text;
      continue;
    }

    // Function call output → assistant tool_use + user tool_result pair
    if (msg.type === "function_call_output") {
      // This is a tool result — add as user message with tool_result block
      const outputText =
        typeof msg.output === "string"
          ? msg.output
          : Array.isArray(msg.output)
            ? msg.output.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
            : JSON.stringify(msg.output);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.call_id,
            content: outputText,
          },
        ],
      });
      continue;
    }

    // Function call (assistant requesting tool use)
    if (msg.type === "function_call") {
      // Convert to assistant message with tool_use block
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: msg.call_id || msg.id,
            name: msg.name,
            input: typeof msg.arguments === "string" ? JSON.parse(msg.arguments) : msg.arguments,
          },
        ],
      });
      continue;
    }

    // Regular user message
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => {
                if (b.type === "input_text" || b.type === "text") return { type: "text", text: b.text };
                if (b.type === "input_image" || b.type === "image") {
                  // Extract base64 data from various formats
                  let imageData = b.data || "";
                  let mediaType = b.media_type || "image/png";
                  const imageUrl = typeof b.image_url === "string" ? b.image_url : b.image_url?.url || "";
                  if (!imageData && imageUrl) {
                    // Parse data URI: data:image/png;base64,AAAA...
                    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                      mediaType = match[1];
                      imageData = match[2];
                    } else {
                      imageData = imageUrl; // Assume raw base64
                    }
                  }
                  if (!imageData) return null; // Skip empty images
                  return {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mediaType,
                      data: imageData,
                    },
                  };
                }
                return { type: "text", text: JSON.stringify(b) };
              }).filter(Boolean)
            : [{ type: "text", text: String(msg.content) }];
      if (content.length > 0) messages.push({ role: "user", content });
      continue;
    }

    // Regular assistant message
    if (msg.role === "assistant") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b) => b.type === "output_text" || b.type === "text")
                .map((b) => ({ type: "text", text: b.text }))
            : [{ type: "text", text: String(msg.content || "") }];
      
      // Check if this assistant message also has tool calls (from history)
      if (msg.output && Array.isArray(msg.output)) {
        const blocks = [];
        for (const item of msg.output) {
          if (item.type === "message" && item.content) {
            for (const c of item.content) {
              if (c.type === "output_text") blocks.push({ type: "text", text: c.text });
            }
          }
          if (item.type === "function_call") {
            blocks.push({
              type: "tool_use",
              id: item.call_id || item.id,
              name: item.name,
              input: typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments,
            });
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks });
          continue;
        }
      }

      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
      continue;
    }
  }

  return { system: systemText, messages };
}

/**
 * Convert OpenAI tool definitions to Anthropic format.
 */
function convertTools(openaiTools) {
  if (!openaiTools || !Array.isArray(openaiTools)) return [];
  return openaiTools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.parameters || t.function?.parameters || { type: "object", properties: {} },
    }));
}

/**
 * Convert OpenAI tool_choice to Anthropic format.
 */
function convertToolChoice(openaiToolChoice) {
  if (!openaiToolChoice) return undefined;
  if (openaiToolChoice === "required") return { type: "any" };
  if (openaiToolChoice === "auto") return { type: "auto" };
  if (openaiToolChoice === "none") return undefined;
  if (typeof openaiToolChoice === "object" && openaiToolChoice.function?.name) {
    return { type: "tool", name: openaiToolChoice.function.name };
  }
  return { type: "auto" };
}

/**
 * Map OpenAI reasoning effort to Anthropic thinking budget.
 */
function getThinkingBudget(reasoningEffort) {
  const budgets = {
    xhigh: 16000,
    high: 10000,
    medium: 5000,
    low: 2000,
  };
  return budgets[reasoningEffort] || budgets.medium;
}

/**
 * Drop-in replacement for openai.responses.create() that uses Anthropic.
 * Returns an async iterable of OpenAI-compatible events.
 */
async function* anthropicResponsesCreate(options) {
  const client = getClient();
  const model = mapModel(options.model);
  const { system, messages } = convertMessages(options.input);
  const tools = convertTools(options.tools);
  const toolChoice = convertToolChoice(options.tool_choice);

  // Ensure messages alternate user/assistant properly
  const cleanedMessages = ensureAlternating(messages);

  const params = {
    model,
    system: system || undefined,
    messages: cleanedMessages,
    max_tokens: options.max_output_tokens || 8192,
    stream: true,
  };

  if (tools.length > 0) {
    params.tools = tools;
    if (toolChoice) params.tool_choice = toolChoice;
  }

  // Add thinking if model supports it (but NOT when tool_choice forces tool use)
  const reasoningEffort = options.reasoning?.effort;
  const forcedToolUse = toolChoice && (toolChoice.type === "any" || toolChoice.type === "tool");
  if (reasoningEffort && !forcedToolUse && (model.includes("sonnet") || model.includes("opus"))) {
    params.thinking = {
      type: "enabled",
      budget_tokens: getThinkingBudget(reasoningEffort),
    };
  }

  // Track usage
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let currentToolUseId = null;
  let currentToolUseName = null;
  let currentToolUseArgs = "";
  let textContent = "";
  let thinkingContent = "";
  let responseId = "";
  let stopReason = "";

  // Collect all output items for the final response
  const outputItems = [];

  try {
    const stream = client.messages.stream(params);

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          responseId = event.message?.id || "";
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
            cacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
            cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0;
          }
          break;

        case "content_block_start":
          if (event.content_block?.type === "tool_use") {
            currentToolUseId = event.content_block.id;
            currentToolUseName = event.content_block.name;
            currentToolUseArgs = "";
            yield {
              type: "response.output_item.added",
              item: { type: "function_call", name: currentToolUseName },
            };
          } else if (event.content_block?.type === "thinking") {
            thinkingContent = "";
            yield {
              type: "response.output_item.added",
              item: { type: "reasoning" },
            };
          } else if (event.content_block?.type === "text") {
            textContent = "";
            yield {
              type: "response.output_item.added",
              item: { type: "message" },
            };
          }
          break;

        case "content_block_delta":
          if (event.delta?.type === "input_json_delta") {
            currentToolUseArgs += event.delta.partial_json || "";
          } else if (event.delta?.type === "thinking_delta") {
            thinkingContent += event.delta.thinking || "";
            // Emit as reasoning summary for dashboard
            yield {
              type: "response.reasoning_summary_text.delta",
              delta: event.delta.thinking || "",
            };
          } else if (event.delta?.type === "text_delta") {
            textContent += event.delta.text || "";
            yield {
              type: "response.output_text.delta",
              delta: event.delta.text || "",
            };
          }
          break;

        case "content_block_stop":
          if (currentToolUseId) {
            // Emit completed tool call
            const toolItem = {
              type: "function_call",
              id: `call_${currentToolUseId}`,
              call_id: currentToolUseId,
              name: currentToolUseName,
              arguments: currentToolUseArgs,
            };
            outputItems.push(toolItem);
            yield {
              type: "response.output_item.done",
              item: toolItem,
            };
            currentToolUseId = null;
            currentToolUseName = null;
            currentToolUseArgs = "";
          } else if (thinkingContent) {
            outputItems.push({ type: "reasoning", text: thinkingContent });
            yield {
              type: "response.reasoning_summary_part.done",
            };
            yield {
              type: "response.output_item.done",
              item: { type: "reasoning" },
            };
            thinkingContent = "";
          } else if (textContent) {
            const textItem = {
              type: "message",
              content: [{ type: "output_text", text: textContent }],
            };
            outputItems.push(textItem);
            yield {
              type: "response.output_item.done",
              item: { type: "output_text" },
            };
            textContent = "";
          }
          break;

        case "message_delta":
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
          stopReason = event.delta?.stop_reason || stopReason;
          break;

        case "message_stop":
          // Build final response in OpenAI format
          const finalResponse = {
            id: responseId,
            model: model,
            output: outputItems,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              input_tokens_details: {
                cached_tokens: cacheReadTokens,
              },
              output_tokens_details: {
                reasoning_tokens: 0,
              },
            },
            stop_reason: stopReason,
          };

          yield {
            type: "response.completed",
            response: finalResponse,
          };
          break;
      }
    }
  } catch (err) {
    console.error("[Anthropic Adapter] Stream error:", err.message);
    throw err;
  }
}

/**
 * Ensure messages alternate between user and assistant.
 * Anthropic requires strict alternation.
 */
function ensureAlternating(messages) {
  if (messages.length === 0) return messages;

  const result = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      // Same role consecutive — merge into previous
      const prev = result[result.length - 1];
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: String(prev.content) }];
      const curContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      prev.content = [...prevContent, ...curContent];
    } else {
      result.push({ ...msg });
    }
  }

  // Anthropic requires first message to be user
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: [{ type: "text", text: "(game state follows)" }] });
  }

  return result;
}

/**
 * Map OpenAI model names to Anthropic equivalents.
 */
function mapModel(openaiModel) {
  const mapping = {
    "gpt-5-nano": "claude-haiku-4-5",
    "gpt-5-mini": "claude-sonnet-4-5",
    "gpt-5.2": "claude-opus-4-6",
    "gpt-5.2-codex": "claude-opus-4-6",
  };
  return mapping[openaiModel] || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
}

module.exports = {
  anthropicResponsesCreate,
  convertMessages,
  convertTools,
  convertToolChoice,
  mapModel,
};
