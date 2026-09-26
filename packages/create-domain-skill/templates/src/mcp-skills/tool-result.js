'use strict';

// Route every tool result through here so the model never receives a blank
// block it has to guess about (host contract, see check-mcp-conformance).
function toolResultText(name, result) {
  if (result === undefined || result === null) return `[${name}] no result`;
  if (typeof result === 'string') return result.trim() ? result : `[${name}] empty result`;
  let text;
  try { text = JSON.stringify(result); } catch { return `[${name}] unrenderable result`; }
  if (!text || text === '{}' || text === '[]') return `[${name}] empty result`;
  return text;
}

module.exports = { toolResultText };
