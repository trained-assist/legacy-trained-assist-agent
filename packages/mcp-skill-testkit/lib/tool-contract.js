'use strict';

// L2 building block: assert the observable MCP contract for each tool without
// binding to a test framework. Aggregates every violation and throws once, so a
// caller can wrap it in it()/test() and get one readable failure.
//
//   const { tools } = await server.call('tools/list');
//   await expectToolContract(server.call, tools, [
//     { name: 'skill_status', validArgs: {}, expectedEnvelope: { ok: true } },
//     { name: 'skill_missing', validArgs: {}, expectError: true },
//   ]);

function resultText(res) {
  const content = res && Array.isArray(res.content) ? res.content : [];
  return content.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function expectToolContract(call, tools, fixtures = []) {
  if (typeof call !== 'function') throw new Error('expectToolContract: `call` must be the server.call function');
  const toolList = Array.isArray(tools) ? tools : (tools && tools.tools) || [];
  const names = new Set(toolList.map((t) => t.name));
  const failures = [];
  const results = [];

  for (const fx of fixtures) {
    if (!fx || !fx.name) { failures.push('fixture is missing `name`'); continue; }
    const tool = toolList.find((t) => t.name === fx.name);
    if (!tool) { failures.push(`tool "${fx.name}" is not advertised in tools/list`); continue; }

    let res;
    try {
      res = await call('tools/call', { name: fx.name, arguments: fx.validArgs || {} });
    } catch (e) {
      failures.push(`tool "${fx.name}" call threw instead of returning an envelope: ${e.message}`);
      continue;
    }

    if (fx.expectError) {
      if (!res || res.isError !== true) {
        failures.push(`tool "${fx.name}" expected isError:true, got ${JSON.stringify(res).slice(0, 200)}`);
      }
    } else if (!res || !Array.isArray(res.content)) {
      failures.push(`tool "${fx.name}" result has no content[] array (got ${JSON.stringify(res).slice(0, 200)})`);
    }

    if (fx.expectedEnvelope !== undefined && res) {
      const text = resultText(res);
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
      if (!deepEqual(parsed, fx.expectedEnvelope)) {
        failures.push(`tool "${fx.name}" envelope mismatch: expected ${JSON.stringify(fx.expectedEnvelope)}, got ${JSON.stringify(parsed).slice(0, 300)}`);
      }
    }

    results.push({ fixture: fx, result: res });
  }

  if (failures.length) {
    const err = new Error('tool contract violations:\n- ' + failures.join('\n- '));
    err.failures = failures;
    err.code = 'TOOL_CONTRACT_VIOLATION';
    throw err;
  }
  return results;
}

module.exports = { expectToolContract, resultText };
