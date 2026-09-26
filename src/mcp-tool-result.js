'use strict';
// Every MCP tools/call must give the model something to read (owner, 2026-09-26). A tool
// that resolves to undefined/''/[]/{} used to reach the model as an empty text block, and
// the model filled the gap with a guess. Enforced at the server boundary, so every tool —
// including ones added later — is covered without per-tool discipline.
function isEmptyToolResult(result) {
  if (result === undefined || result === null) return true;
  if (typeof result === 'string') return !result.trim();
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === 'object') return Object.keys(result).length === 0;
  return false;
}

function emptyToolResultText(name) {
  return `⚠️ Инструмент ${name} вернул пустой результат (нет данных). Не додумывай содержимое: скажи пользователю, что инструмент ничего не вернул.`;
}

function toolResultText(name, result, { pretty = true } = {}) {
  if (isEmptyToolResult(result)) {
    console.error(`[mcp] tool ${name} returned an empty result`);
    return emptyToolResultText(name);
  }
  if (typeof result === 'string') return result;
  return pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}

module.exports = { isEmptyToolResult, emptyToolResultText, toolResultText };
