'use strict';

const fs = require('fs');
const path = require('path');
const mediaVision = require('./media-vision');

function safeFileName(name) {
  return path.basename(name || 'file').replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200) || 'file';
}

function fsyncPath(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

async function buildFileNote({ filePath, mimeType, engine, openrouterKey, vision = mediaVision }) {
  const typeNote = mimeType ? ` (${mimeType})` : '';
  let note = `[Файл сохранён: ${filePath}${typeNote}. Временное медиа: TTL 48 часов. Если файл нужен проекту надолго, сохрани его в артефакты проекта.]`;
  if (engine === 'opencode' && mimeType?.startsWith('image/') && openrouterKey) {
    const result = await vision.extractImageText({ filePath, mimeType, openrouterKey });
    if (result.ok) note += `\n[Распознано на изображении:\n${result.text}]`;
    // A silent failure left the 29.09 04:02 screenshot with no block and no way to
    // tell why (credits? network? refusal?) — the reason now reaches journalctl.
    else console.warn(`[vision] no recognition (${result.reason || 'unknown'}) for ${filePath}`);
  }
  return note;
}

async function materializeFileRefs({
  workDir, username, fileRefs, task = '', engine, openrouterKey,
  gatewayUrl, agentSecret, vision = mediaVision, r2 = require('./r2-media'),
}) {
  if (!Array.isArray(fileRefs) || !fileRefs.length) return { task, fileRefs: [] };
  const uploadsDir = path.join(workDir, 'media', 'intake');
  fs.mkdirSync(uploadsDir, { recursive: true });
  let effectiveTask = task || '';
  const normalized = [];

  for (const ref of fileRefs) {
    if (!ref?.id || !/^[a-f0-9]{16,64}$/.test(ref.id)) {
      const error = new Error('invalid fileRef'); error.statusCode = 400; throw error;
    }
    const storeDir = path.join(workDir, 'media', 'intake-store', ref.id);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8')); } catch {}
    const name = safeFileName(ref.name || meta.name || 'file');
    const mime = ref.mime || ref.type || meta.mime || 'application/octet-stream';
    const filePath = path.join(uploadsDir, `${ref.id}-${name}`);

    try {
      if (ref.storage === 'r2') {
        await r2.materializeR2({
          ref, username, destination: filePath, gatewayUrl, secret: agentSecret,
        });
      } else {
        if (ref.storage) throw new Error('Unknown media storage');
        fs.copyFileSync(path.join(storeDir, 'data'), filePath);
      }
      fsyncPath(filePath);
    } catch (cause) {
      const error = new Error('attachment not persisted');
      error.statusCode = 503; error.cause = cause; throw error;
    }

    // Compressor (gateway marks it): a transcribed voice/audio ref is pure noise
    // for the model — copy it and release the pin, but withhold the file note.
    if (ref.note !== false) {
      const note = await buildFileNote({
        filePath, mimeType: mime, engine, openrouterKey, vision,
      });
      effectiveTask = effectiveTask ? `${note}\n\n${effectiveTask}` : note;
    }
    normalized.push({ ...ref, id: ref.id, name, mime });
  }

  return { task: effectiveTask, fileRefs: normalized };
}

module.exports = { safeFileName, buildFileNote, materializeFileRefs };
