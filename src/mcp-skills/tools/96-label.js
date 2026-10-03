'use strict';

// image_label — overlays text annotations onto an image via sharp + SVG.
// Supports two modes:
//   1. Explicit: labels[] with x,y coordinates → direct application
//   2. Auto (Vision pass): structures[] strings → Vision pass detects positions → apply
// Iteration-friendly: stores last label state per image_url for adjustments.

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const os    = require('os');
// The vision pass goes through the llm-ladder worker (src/service-llm.js) like every other
// LLM call in the agent — never a direct provider API. The worker owns the key pool, rung
// failover and per-call attribution; a direct vendor call here would bypass all of that
// (and no vendor key lives on the box any more — see tests/no-direct-provider-api.test.js).
const { serviceChat } = require('../../service-llm');

const HISTORY_FILE = path.join(os.homedir(), 'agent-data', 'label-history.json');

// ── History (for iteration) ───────────────────────────────────────────────────

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
}
function saveHistory(key, entry) {
  const h = loadHistory();
  h[key] = entry;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
  } catch {}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 30000 }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' }));
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('timeout fetching image')));
  });
}

// ── Vision pass (via the llm-ladder worker) ───────────────────────────────────

async function detectPositionsViaVision(imageBuffer, structures, imageDescription) {
  const base64 = imageBuffer.toString('base64');
  const structureList = structures.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const prompt = [
    imageDescription
      ? `This is an illustration of: ${imageDescription}\n\n`
      : '',
    'For each structure listed below, determine its CENTER position in the image.',
    'Express as x (0=left edge, 100=right edge) and y (0=top edge, 100=bottom edge) percentage.',
    'Also suggest label placement: side="left" if the structure is in the right half of the image (label goes to left), side="right" otherwise.',
    '',
    'Structures to locate:',
    structureList,
    '',
    'Respond with ONLY valid JSON array, no explanation:',
    '[{"structure":"...", "x": 50, "y": 30, "side": "left"}, ...]',
    'If a structure is not visible in the image, set "visible": false.',
  ].join('\n');

  // The worker picks the rung (the service ladder carries multimodal models) and owns the key.
  const r = await serviceChat({
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
    json: true,
    maxTokens: 1024,
    source: 'label-vision',
  });
  if (!r) throw new Error('Vision pass unavailable — the llm-ladder worker returned no answer (no token / unreachable / every rung failed)');

  const text = r.content || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Vision response not parseable: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ── SVG overlay builder ───────────────────────────────────────────────────────

function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildSvgOverlay(labels, width, height, fontSize = 26) {
  const elems = [];
  for (const l of labels) {
    const px = Math.round(l.x * width  / 100);
    const py = Math.round(l.y * height / 100);
    const anchor = l.anchor || 'start';
    const color  = l.color  || '#111111';
    const bg     = l.bg     || 'white';

    if (l.line_x != null && l.line_y != null) {
      const lx = Math.round(l.line_x * width  / 100);
      const ly = Math.round(l.line_y * height / 100);
      elems.push(`<line x1="${px}" y1="${py}" x2="${lx}" y2="${ly}" stroke="${bg}" stroke-width="3" stroke-opacity="0.7"/>`);
      elems.push(`<line x1="${px}" y1="${py}" x2="${lx}" y2="${ly}" stroke="${color}" stroke-width="1.5"/>`);
      // Small dot at target point
      elems.push(`<circle cx="${lx}" cy="${ly}" r="3" fill="${color}" stroke="${bg}" stroke-width="1.5"/>`);
    }

    elems.push(
      `<text x="${px}" y="${py}" ` +
      `font-family="FreeSans, DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}" ` +
      `text-anchor="${anchor}" ` +
      `stroke="${bg}" stroke-width="4" stroke-linejoin="round" paint-order="stroke" ` +
      `fill="${color}">${escXml(l.text)}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${elems.join('\n')}</svg>`;
}

// ── Telegram send ─────────────────────────────────────────────────────────────

function sendToTelegram(buf, filename, caption) {
  const BOT_TOKEN = process.env.AGENT_BOT_TOKEN;
  const chatId    = process.env.AGENT_CHAT_ID;
  if (!BOT_TOKEN || !chatId) throw new Error('No AGENT_BOT_TOKEN/AGENT_CHAT_ID in env');

  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now()}`;
    const CRLF = '\r\n';
    function field(name, value) {
      return `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;
    }
    function filePart(name, fname, ct, data) {
      return Buffer.concat([
        Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${fname}"${CRLF}Content-Type: ${ct}${CRLF}${CRLF}`),
        data, Buffer.from(CRLF),
      ]);
    }
    const parts = [
      Buffer.from(field('chat_id', String(chatId))),
      Buffer.from(caption ? field('caption', caption.slice(0, 1024)) : ''),
      filePart('photo', filename, 'image/jpeg', buf),
      Buffer.from(`--${boundary}--${CRLF}`),
    ];
    const body = Buffer.concat(parts);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Opt-in gate (same flag as 95-illustrate) ─────────────────────────────────

function isEnabled() {
  return fs.existsSync(path.join(process.cwd(), 'contexts', 'illustrate', '.enabled'));
}

// ── Main tool ─────────────────────────────────────────────────────────────────

module.exports = {
  isReady: isEnabled,
  tools: {
  image_label: {
    description:
      'Add text annotations to an image in any language including Russian/Cyrillic. ' +
      'TWO MODES: ' +
      '(1) AUTO: provide structures[] with label texts — Vision pass detects positions automatically. ' +
      '(2) MANUAL: provide labels[] with explicit x,y coordinates. ' +
      'Use AUTO first; if positions are wrong the user will say so and you can call again with adjusted labels[].',
    inputSchema: {
      type: 'object',
      required: ['image_url'],
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of image to label. Use image_url from illustrate_generate.',
        },
        structures: {
          type: 'array',
          items: { type: 'string' },
          description:
            'AUTO MODE: list of structure names to label (e.g. ["Эпидермис","Дерма","Гиподерма"]). ' +
            'The vision model will detect their positions automatically. Use this on first attempt.',
        },
        labels: {
          type: 'array',
          description:
            'MANUAL MODE: labels with explicit coordinates. Use for iteration when AUTO positions are off. ' +
            'Previous auto-detected positions are in the tool result — copy and adjust.',
          items: {
            type: 'object',
            required: ['text', 'x', 'y'],
            properties: {
              text:   { type: 'string' },
              x:      { type: 'number', description: '0=left edge, 100=right edge' },
              y:      { type: 'number', description: '0=top edge, 100=bottom edge' },
              anchor: { type: 'string', enum: ['start','middle','end'], description: 'Default: start' },
              line_x: { type: 'number', description: 'X of the structure being pointed to (0-100)' },
              line_y: { type: 'number', description: 'Y of the structure being pointed to (0-100)' },
              color:  { type: 'string', description: 'Text color. Default: #111111' },
            },
          },
        },
        image_description: {
          type: 'string',
          description: 'Optional: what the image shows. Used in AUTO mode to improve Vision accuracy. Pass revised_prompt from illustrate_generate if available.',
        },
        font_size: { type: 'number', description: 'Font size px. Default: 26. Use 20 for many labels, 32 for few.' },
        caption:   { type: 'string', description: 'Telegram caption text.' },
      },
    },

    handler: async ({ image_url, structures, labels, image_description, font_size, caption }) => {
      if (!structures?.length && !labels?.length) {
        return { error: 'missing_input', message: 'Provide either structures[] (auto mode) or labels[] (manual mode).' };
      }

      // 1. Download image
      let imgBuf;
      try { ({ buffer: imgBuf } = await fetchBuffer(image_url)); }
      catch (e) { return { error: 'download_failed', message: e.message }; }

      let sharp;
      try { sharp = require('sharp'); } catch { return { error: 'sharp_missing', message: 'sharp not installed' }; }

      let meta;
      try { meta = await sharp(imgBuf).metadata(); }
      catch (e) { return { error: 'image_read_failed', message: e.message }; }

      const { width, height } = meta;

      // 2. Determine label positions
      let resolvedLabels;

      if (structures?.length) {
        // AUTO MODE — Vision pass
        let visionResult;
        try {
          visionResult = await detectPositionsViaVision(imgBuf, structures, image_description);
        } catch (e) {
          return { error: 'vision_failed', message: e.message };
        }

        resolvedLabels = visionResult
          .filter(v => v.visible !== false)
          .map(v => {
            // Label goes to the side opposite the structure
            const labelX = v.side === 'left'
              ? Math.max(2, v.x - 28)   // label to left of structure
              : Math.min(98, v.x + 5);  // label to right
            const anchor = v.side === 'left' ? 'end' : 'start';
            return {
              text:   v.structure,
              x:      labelX,
              y:      v.y,
              anchor,
              line_x: v.x,
              line_y: v.y,
            };
          });

        // Save for iteration
        saveHistory(image_url, { image_url, resolvedLabels, image_description });

      } else {
        // MANUAL MODE — use provided labels directly
        resolvedLabels = labels;
      }

      if (!resolvedLabels.length) {
        return { error: 'no_labels', message: 'Vision detected no visible structures. Try manual mode with explicit coordinates.' };
      }

      // 3. Build SVG and composite
      const svg = buildSvgOverlay(resolvedLabels, width, height, font_size || 26);
      let outBuf;
      try {
        outBuf = await sharp(imgBuf)
          .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
          .jpeg({ quality: 92 })
          .toBuffer();
      } catch (e) { return { error: 'composite_failed', message: e.message }; }

      // 4. Send to Telegram
      const fname = `labeled_${Date.now()}.jpg`;
      let tgOk = false;
      try {
        const r = await sendToTelegram(outBuf, fname, caption || null);
        tgOk = r?.ok === true;
      } catch (e) { console.error('[image_label] telegram:', e.message); }

      return {
        ok: true,
        mode: structures?.length ? 'auto (Vision pass)' : 'manual',
        labels_applied: resolvedLabels.length,
        image_size: `${width}×${height}`,
        sent_to_telegram: tgOk,
        detected_positions: resolvedLabels.map(l => ({
          text: l.text, x: l.x, y: l.y, line_x: l.line_x, line_y: l.line_y,
        })),
        iteration_tip: 'If any label position is wrong, call image_label again with labels[] (manual mode) — copy detected_positions above and adjust the x/y values of the wrong ones.',
      };
    },
  },
  },
};
