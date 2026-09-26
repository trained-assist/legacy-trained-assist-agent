import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildNalogOrigins, writeMcpConfig } from '../src/browser.js';

const HH_SKILL_SUFFIX = path.join('trained-assist-hh-skill', 'src', 'mcp-skills', 'index.js');
const ENGINEERING_SKILL_SUFFIX = path.join('trained-assist-engineering', 'src', 'mcp-skills', 'index.js');

let tmpDir;
let tokenFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-'));
  tokenFile = path.join(tmpDir, 'nalog');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildNalogOrigins', () => {
  it('returns one origin with sessionStorage for valid auth_token', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({
      auth_token: 'jwt.token.here',
      refresh_token: 'refresh.here',
      expires: '2026-09-01T00:00:00Z',
    }));

    const origins = buildNalogOrigins(tokenFile);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin).toBe('https://lknpd.nalog.ru');
    expect(Array.isArray(origins[0].sessionStorage)).toBe(true);

    const names = origins[0].sessionStorage.map(i => i.name);
    expect(names).toContain('auth.token');
    expect(names).toContain('refresh.token');

    const authItem = origins[0].sessionStorage.find(i => i.name === 'auth.token');
    expect(authItem.value).toBe('jwt.token.here');
  });

  it('includes refresh.token when present', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({
      auth_token: 'tok',
      refresh_token: 'ref',
    }));

    const origins = buildNalogOrigins(tokenFile);
    const names = origins[0].sessionStorage.map(i => i.name);
    expect(names).toContain('refresh.token');
  });

  it('returns [] for invalid JSON', () => {
    fs.writeFileSync(tokenFile, 'not valid json {{{');
    expect(buildNalogOrigins(tokenFile)).toEqual([]);
  });

  it('returns [] when auth_token is missing', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'only-refresh' }));
    expect(buildNalogOrigins(tokenFile)).toEqual([]);
  });

  it('returns [] for non-existent file', () => {
    expect(buildNalogOrigins('/nonexistent/path/nalog')).toEqual([]);
  });
});

// Regression coverage for the extraction-checklist step 6/7 wiring (issue #942, PR #1107):
// writeMcpConfig must register the 'hh-skills' MCP server only when the sibling
// trained-assist-hh-skill checkout is actually present on disk, so environments without
// it cloned (a fresh CI runner, a laptop clone) keep working unchanged.
describe('writeMcpConfig hh-skills registration', () => {
  const realExistsSync = fs.existsSync;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers hh-skills when the sibling checkout is present', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(HH_SKILL_SUFFIX) ? true : realExistsSync(p));

    const configPath = writeMcpConfig(tmpDir, null, {});
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers).toHaveProperty('hh-skills');
    expect(config.mcpServers['hh-skills'].command).toBe('node');
    expect(config.mcpServers['hh-skills'].args[0]).toMatch(/trained-assist-hh-skill.*mcp-skills.*index\.js$/);
    // Always present regardless of hh-skills availability
    expect(config.mcpServers).toHaveProperty('trained-skills');
  });

  it('omits hh-skills when the sibling checkout is absent', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(HH_SKILL_SUFFIX) ? false : realExistsSync(p));

    const configPath = writeMcpConfig(tmpDir, null, {});
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers).not.toHaveProperty('hh-skills');
    expect(config.mcpServers).toHaveProperty('trained-skills');
  });
});

// Issue #1418: mount the sibling trained-assist-engineering MCP server exactly
// like hh-skills/freelance-skills — present only when its checkout exists.
describe('writeMcpConfig engineering-skills registration', () => {
  const realExistsSync = fs.existsSync;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers engineering-skills when the sibling checkout is present', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(ENGINEERING_SKILL_SUFFIX) ? true : realExistsSync(p));

    const configPath = writeMcpConfig(tmpDir, null, {});
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers).toHaveProperty('engineering-skills');
    expect(config.mcpServers['engineering-skills'].command).toBe('node');
    expect(config.mcpServers['engineering-skills'].args[0]).toMatch(/trained-assist-engineering.*mcp-skills.*index\.js$/);
    expect(config.mcpServers).toHaveProperty('trained-skills');
  });

  it('omits engineering-skills when the sibling checkout is absent', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(ENGINEERING_SKILL_SUFFIX) ? false : realExistsSync(p));

    const configPath = writeMcpConfig(tmpDir, null, {});
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers).not.toHaveProperty('engineering-skills');
    expect(config.mcpServers).toHaveProperty('trained-skills');
  });
});

// Issue #1470 P0.1c / #1511: the HH serving toggle. When the host source runtime
// materializes a sealed hh source for the run (extraServers['hh-skills']) that
// adapter must win and the sibling checkout must NOT be registered — otherwise
// the sibling name would shadow the adapter via mergeAdapterServers(). With no
// sealed server for the run (admin config rolled back, profile ineligible,
// artifact unavailable) the sibling is the core fallback.
describe('writeMcpConfig sealed-source toggle (hh core <-> domain)', () => {
  const sealedServers = () => ({
    'hh-skills': { command: process.execPath, args: ['/opt/adapter.js', '--binding-file', '/run/hh-skills/run-binding.json'] },
  });

  function presentSibling(name = 'hh-sibling-index.js') {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, '// sibling MCP entry');
    return p;
  }

  it('a sealed hh source wins over a present sibling checkout', () => {
    const sibling = presentSibling();
    const configPath = writeMcpConfig(tmpDir, null, { extraServers: sealedServers(), siblingPaths: { 'hh-skills': sibling } });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers['hh-skills'].args[0]).toBe('/opt/adapter.js');
    expect(config.mcpServers['hh-skills'].args.join(' ')).toContain('run-binding.json');
    expect(config.mcpServers['hh-skills'].args[0]).not.toBe(sibling);
    expect(config.mcpServers).toHaveProperty('trained-skills');
  });

  it('falls back to the sibling (core) when no sealed server is materialized for the run', () => {
    const sibling = presentSibling();
    const configPath = writeMcpConfig(tmpDir, null, { siblingPaths: { 'hh-skills': sibling } });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(config.mcpServers['hh-skills'].command).toBe('node');
    expect(config.mcpServers['hh-skills'].args[0]).toBe(sibling);
  });

  it('does not resurrect a stale sibling path for a sealed run (negative test)', () => {
    const sibling = presentSibling();
    const configPath = writeMcpConfig(tmpDir, null, { extraServers: sealedServers(), siblingPaths: { 'hh-skills': sibling } });
    const written = fs.readFileSync(configPath, 'utf8');

    expect(written).not.toContain(sibling);
  });
});
