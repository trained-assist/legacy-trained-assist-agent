// L2 behavior (hermetic): real stdio server + recorded fixtures only.
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer, expectToolContract } from '@trained-assist/mcp-skill-testkit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(root, 'src', 'mcp-skills', 'index.js');

test('every tool returns a valid content envelope (or isError, never a crash)', async () => {
  const server = await startMcpServer({ entrypoint, workDir: root });
  try {
    const { tools } = await server.call('tools/list');
    await expectToolContract(server.call, tools, [
      { name: 'example_status', validArgs: {}, expectedEnvelope: { ok: true, domain: '{{domain}}' } },
    ]);
  } finally {
    await server.stop();
  }
});
