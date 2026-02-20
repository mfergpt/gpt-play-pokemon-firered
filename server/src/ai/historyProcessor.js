const { config } = require("../config");

function truncateText(text, maxChars, marker = "\n...[truncated]...\n") {
  if (typeof text !== "string") return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - marker.length);
  return text.slice(0, keep) + marker;
}

function truncateTaggedBlock(text, tagName, maxChars) {
  if (typeof text !== "string" || !Number.isFinite(maxChars) || maxChars <= 0) return text;
  const re = new RegExp(`(<${tagName}[^>]*>)([\\s\\S]*?)(</${tagName}>)`);
  const match = text.match(re);
  if (!match) return text;
  const [, openTag, body, closeTag] = match;
  if (body.length <= maxChars) return text;
  return text.replace(re, `${openTag}${truncateText(body, maxChars)}${closeTag}`);
}

function cleanTextSections(text, sectionsToRemove) {
  let cleanedText = text;
  if (sectionsToRemove.minimap) {
    cleanedText = cleanedText.replace(/<explored_map>[\s\S]*?<\/explored_map>\s*/g, "");
  }
  if (sectionsToRemove.view_map) {
    cleanedText = cleanedText.replace(/<visible_area>[\s\S]*?<\/visible_area>\s*/g, "");
  }
  if (sectionsToRemove.memory) {
    cleanedText = cleanedText.replace(/<memory>[\s\S]*?<\/memory>\s*/g, "");
    cleanedText = cleanedText.replace(/<markers>[\s\S]*?<\/markers>\s*/g, "");
    cleanedText = cleanedText.replace(/<action_context[\s\S]*?<\/action_context>\s*/g, "");
    cleanedText = cleanedText.replace(/<menu_tips>[\s\S]*?<\/menu_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<ui_state>[\s\S]*?<\/ui_state>\s*/g, "");
  }
  if (sectionsToRemove.player_data) {
    cleanedText = cleanedText.replace(/<player_stats>[\s\S]*?<\/player_stats>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state>[\s\S]*?<\/battle_state>\s*/g, "");
    cleanedText = cleanedText.replace(/<objectives_section>[\s\S]*?<\/objectives_section>\s*/g, "");
    cleanedText = cleanedText.replace(/<objectives>[\s\S]*?<\/objectives>\s*/g, "");
    cleanedText = cleanedText.replace(/<pc_tips>[\s\S]*?<\/pc_tips>\s*/g, "");
    cleanedText = cleanedText.replace(/<battle_state[\s\S]*?<\/battle_state>\s*/g, "");
  }
  if (sectionsToRemove.pokedex_data) {
    cleanedText = cleanedText.replace(/<pokedex_data>[\s\S]*?<\/pokedex_data>\s*/g, "");
  }
  if (sectionsToRemove.live_chat) {
    cleanedText = cleanedText.replace(/<live_chat>[\s\S]*?<\/live_chat>\s*/g, "");
  }
  return cleanedText;
}

function applyHistorySectionCaps(text) {
  // Use the "main" caps for history continuity to avoid over-pruning navigation context.
  const caps = config.context?.sectionMaxChars || {};
  let out = text;
  for (const [tag, maxChars] of Object.entries(caps)) {
    if (!Number.isFinite(maxChars) || maxChars <= 0) continue;
    const capped = Math.min(maxChars, Math.ceil(maxChars * 0.95));
    out = truncateTaggedBlock(out, tag, capped);
  }
  return out;
}

function compactToolResultText(text, maxChars, detailsMaxChars) {
  if (typeof text !== "string") return text;
  let output = text;

  if (Number.isFinite(detailsMaxChars) && detailsMaxChars > 0) {
    output = output.replace(/<details>([\s\S]*?)<\/details>/g, (_, detailsBody) => {
      return `<details>${truncateText(detailsBody, detailsMaxChars)}</details>`;
    });
  }

  if (Number.isFinite(maxChars) && maxChars > 0) {
    output = truncateText(output, maxChars);
  }

  return output;
}

function compactToolResultForStorage(message) {
  if (!message || message.type !== "function_call_output") return message;

  const maxChars = config.context?.toolResultStoreMaxChars || 2400;
  const detailsMaxChars = config.history?.toolResultDetailsMaxChars || 450;
  const out = JSON.parse(JSON.stringify(message));

  if (Array.isArray(out.output)) {
    out.output = out.output
      .filter((item) => item?.type !== "input_image")
      .map((item) => {
        if (item?.type !== "input_text" || typeof item.text !== "string") return item;
        return { ...item, text: compactToolResultText(item.text, maxChars, detailsMaxChars) };
      });
  } else if (typeof out.output === "string") {
    out.output = compactToolResultText(out.output, maxChars, detailsMaxChars);
  }

  return out;
}

function isSystemToolReminderMessage(message) {
  if (message?.role !== "user" || !Array.isArray(message?.content)) return false;
  return (
    message.content.length === 1 &&
    message.content[0].type === "input_text" &&
    message.content[0].text ===
      "<system>You must include tools in your response ! Always call 'execute_action' tool with your messages to continue your actions !</system>"
  );
}

function compactUserMessageForStorage(message) {
  if (!message || message.role !== "user") return message;
  if (isSystemToolReminderMessage(message)) return message;

  const out = JSON.parse(JSON.stringify(message));
  if (!Array.isArray(out.content)) return out;

  out.content = out.content
    .filter((item) => item?.type !== "input_image")
    .map((item) => {
      if (item?.type !== "input_text" || typeof item.text !== "string") return item;
      let text = cleanTextSections(item.text, { live_chat: false });
      text = applyHistorySectionCaps(text);
      text = truncateText(text, config.history.userMessageMaxChars);
      return { ...item, text };
    });

  if (out.content.length === 0) {
    out.content = [{ type: "input_text", text: "<system>Image payload omitted from stored history.</system>" }];
  }

  return out;
}

function compactAssistantOutputItemForStorage(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "reasoning") return null;

  const out = JSON.parse(JSON.stringify(item));
  delete out.id;

  if (out.type === "message" && Array.isArray(out.content)) {
    out.content = out.content
      .filter((c) => c?.type === "output_text")
      .map((c) => ({
        ...c,
        text: truncateText(String(c.text || ""), Math.min(10000, config.history.userMessageMaxChars || 45000)),
      }));
    if (out.content.length === 0) return null;
  }

  if (out.type === "function_call" && typeof out.arguments === "string") {
    out.arguments = truncateText(out.arguments, 8000);
  }

  return out;
}

function compactHistoryEntryForStorage(entry) {
  if (!entry) return entry;
  if (entry.role === "user") return compactUserMessageForStorage(entry);
  if (entry.type === "function_call_output") return compactToolResultForStorage(entry);
  if (entry.type === "message" || entry.type === "function_call" || entry.type === "reasoning") {
    return compactAssistantOutputItemForStorage(entry);
  }
  return entry;
}

function processHistoryForAPI(currentHistory) {
  const userDataMessageIndices = currentHistory.reduce((acc, message, index) => {
    const isUserDataMessage = message.role === "user" && !isSystemToolReminderMessage(message);
    if (isUserDataMessage) acc.push(index);
    return acc;
  }, []);

  const toolResultIndices = currentHistory.reduce((acc, message, index) => {
    if (message.type === "function_call_output") acc.push(index);
    return acc;
  }, []);

  const minimapKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithMinimap));
  const viewMapKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithViewMap));
  const detailedDataKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithDetailedData));
  const imagesKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithImages));
  const toolResultKeepIndices = new Set(toolResultIndices.slice(-config.history.keepLastNToolFullResults));
  const memoryKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithMemory));
  const pokedexKeepIndices = new Set(userDataMessageIndices.slice(-config.history.keepLastNUserMessagesWithPokedex));

  return currentHistory
    .map((message, index) => {
      const newMessage = JSON.parse(JSON.stringify(message));

      if (newMessage.role === "user") {
        if (isSystemToolReminderMessage(newMessage)) return newMessage;
        if (!Array.isArray(newMessage.content)) return newMessage;

        const textContentIndex = newMessage.content.findIndex((item) => item.type === "input_text");
        const originalText = textContentIndex !== -1 ? newMessage.content[textContentIndex].text : null;
        const isSummaryCarryMessage =
          typeof originalText === "string" &&
          (originalText.includes("<previous_summary>") || originalText.includes("<summary>"));

        if (typeof originalText === "string" && !isSummaryCarryMessage) {
          const sectionsToRemove = {
            minimap: !minimapKeepIndices.has(index),
            view_map: !viewMapKeepIndices.has(index),
            memory: !memoryKeepIndices.has(index),
            game_area: !detailedDataKeepIndices.has(index),
            player_data: !detailedDataKeepIndices.has(index),
            pokedex_data: !pokedexKeepIndices.has(index),
            live_chat: !detailedDataKeepIndices.has(index),
          };

          let compacted = cleanTextSections(originalText, sectionsToRemove);
          compacted = applyHistorySectionCaps(compacted);
          compacted = truncateText(compacted, config.history.userMessageMaxChars);
          newMessage.content[textContentIndex].text = compacted;
        } else if (typeof originalText === "string") {
          // Keep summary carry-over mostly intact, but cap pathological entries.
          newMessage.content[textContentIndex].text = truncateText(
            originalText,
            config.history.userMessageMaxChars * 2
          );
        }

        if (!imagesKeepIndices.has(index)) {
          newMessage.content = newMessage.content.filter((item) => item.type !== "input_image");
        }
        return newMessage;
      }

      if (newMessage.type === "function_call_output") {
        const maxChars = toolResultKeepIndices.has(index)
          ? config.history.toolResultKeepMaxChars
          : config.history.toolResultDropMaxChars;
        const detailsMaxChars = config.history.toolResultDetailsMaxChars;

        if (Array.isArray(newMessage.output)) {
          newMessage.output = newMessage.output
            .filter((item) => item?.type !== "input_image")
            .map((item) => {
              if (item?.type !== "input_text" || typeof item.text !== "string") return item;
              const cleaned = cleanTextSections(item.text, {
                minimap: !minimapKeepIndices.has(index),
                view_map: !viewMapKeepIndices.has(index),
                memory: !memoryKeepIndices.has(index),
                game_area: !detailedDataKeepIndices.has(index),
                player_data: !detailedDataKeepIndices.has(index),
                pokedex_data: !pokedexKeepIndices.has(index),
                live_chat: true,
              });
              return {
                ...item,
                text: compactToolResultText(cleaned, maxChars, detailsMaxChars),
              };
            });
        } else if (typeof newMessage.output === "string") {
          newMessage.output = compactToolResultText(newMessage.output, maxChars, detailsMaxChars);
        }
        return newMessage;
      }

      return message;
    })
    .filter((message) => message !== null);
}

module.exports = {
  cleanTextSections,
  processHistoryForAPI,
  compactToolResultForStorage,
  compactUserMessageForStorage,
  compactAssistantOutputItemForStorage,
  compactHistoryEntryForStorage,
};
