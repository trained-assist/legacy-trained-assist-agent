'use strict';
// Identity ≠ location для GTD/orphan-записей (#1813): адрес checklist.md хранится
// ОТНОСИТЕЛЬНО корня профиля (`projectPath`), а не абсолютным `projectDir` —
// перенос/копия профиля (profile-migrate, worktree, смена USERS_DIR) не оставляет
// мёртвых путей. Абсолютный `projectDir` остаётся ТОЛЬКО для каталогов ВНЕ профиля
// (самим они с профилем не переезжают).
//
// Форматы хранения:
//   новый  { "projectPath": "projects/p1" } | { "projectPath": "." }  — внутри профиля
//          { "projectDir":  "/elsewhere" }                            — вне профиля
//   старый { "projectDir":  "<абс>" } — читается как есть, переписывается
//          относительным при СЛЕДУЮЩЕЙ записи (самоизлечение, без миграции).
//
// В памяти запись всегда в ЛЕГАСИ-форме (абсолютный projectDir): все читатели
// (dedup-сравнения `r.projectDir === projectDir`, trackedChecklist, …) работают
// без изменений. Нормализация — ровно на двух границах:
//   loadProjectRef(workDir, rec)   — чтение файла → rec.projectDir (абс) в памяти;
//   storeProjectRef(workDir, rec)  — запись файла → копия с projectPath XOR projectDir.
//
// Legacy-salvage: абсолютный путь из БЫВШЕГО корня профиля восстанавливается по
// структуре, чтобы запись, созданная ДО переноса, читала checklist.md в новом
// расположении (иначе копия профиля молчит/читает старый каталог):
//   <бывший корень>/projects/<id> → <текущий корень>/projects/<id>, если существует;
//   <бывший корень> (корень профиля) → текущий корень — если в бывшем корне лежит
//     ЭТА ЖЕ GTD-запись (gtd/<sessionId>.json), т.е. путь действительно был корнем.
// Внешние каталоги (вне профиля) НЕ «спасаются» — им это ни к чему: они с профилем
// не переезжают.
const fs = require('fs');
const path = require('path');

// Относительный адрес внутри профиля: 'projects/p1', '.' для самого корня;
// null — путь вне профиля (или не задан).
function relProjectPath(workDir, dir) {
  if (!workDir || !dir) return null;
  const root = path.resolve(workDir);
  const abs = path.resolve(dir);
  if (abs === root) return '.';
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Маркеры корня профиля: без них <бывший корень>/projects/<id> не считаем
// бывшим корнем — иначе чужой внешний <…>/projects/<id> увёл бы адрес к себе.
const PROFILE_MARKERS = ['sessions.json', 'gtd', 'gtd-orphans.json'];

function _looksLikeProfileRoot(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch { return false; }
  return PROFILE_MARKERS.some(m => fs.existsSync(path.join(dir, m)));
}

// Бывший корень профиля → текущий. Только для путей, уже лежащих ВНЕ текущего корня.
function _salvageLegacyDir(root, rec, abs) {
  // 1) <бывший корень>/projects/<id> → <текущий корень>/projects/<id>
  const segs = abs.split(path.sep).filter(Boolean);
  if (segs.length >= 2 && segs[segs.length - 2] === 'projects') {
    const id = segs[segs.length - 1];
    const cand = path.join(root, 'projects', id);
    // Гвард от совпадения с чужим <…>/projects/<id> вне профиля: переносим, только
    // если путь мёртв (профиль переехал) либо это действительно бывший корень
    // профиля (профиль скопировали рядом — старая копия ещё существует).
    const formerRoot = path.dirname(path.dirname(abs));
    if (id && fs.existsSync(cand) && (!fs.existsSync(abs) || _looksLikeProfileRoot(formerRoot))) {
      return cand;
    }
  }
  // 2) бывший КОРЕНЬ профиля (копия): в нём лежит эта же запись → это он и есть
  if (rec && rec.sessionId && /^[A-Za-z0-9_.:-]+$/.test(String(rec.sessionId))
    && fs.existsSync(path.join(abs, 'gtd', `${rec.sessionId}.json`))) {
    return root;
  }
  return abs;
}

// Резолвер на ЧТЕНИЕ: абсолютный каталог checklist.md для записи в ЛЮБОМ формате.
// Чистая функция (rec не мутирует) — нормализацию в памяти делает loadProjectRef.
function gtdProjectDir(workDir, rec) {
  if (!rec || !workDir) return null;
  if (rec.projectPath) return path.resolve(workDir, String(rec.projectPath));
  const raw = rec.projectDir;
  if (!raw) return null;
  const root = path.resolve(workDir);
  if (!path.isAbsolute(raw)) return path.resolve(root, raw); // defensive: относительный legacy
  const abs = path.resolve(raw);
  if (abs === root) return root;
  const rel = path.relative(root, abs);
  if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return abs; // профиль не переезжал
  return _salvageLegacyDir(root, rec, abs);
}

// Граница ЧТЕНИЯ: rec → ЛЕГАСИ-форма в памяти (абсолютный projectDir, без projectPath).
function loadProjectRef(workDir, rec) {
  if (!rec) return rec;
  const abs = gtdProjectDir(workDir, rec);
  if (abs) { rec.projectDir = abs; delete rec.projectPath; }
  return rec;
}

// Граница ЗАПИСИ: копия rec для JSON — ровно ОДНО поле адреса:
// projectPath (внутри профиля) либо projectDir (вне профиля).
// projectDir в памяти авторитетен (он уже пережил loadProjectRef) — projectPath
// в копии всегда пересчитывается, устаревшее поле не может протечь на диск.
function storeProjectRef(workDir, rec) {
  const out = { ...rec };
  delete out.projectPath;
  delete out.projectDir;
  const abs = rec.projectDir
    ? (path.isAbsolute(rec.projectDir) ? path.resolve(rec.projectDir) : path.resolve(workDir, rec.projectDir))
    : gtdProjectDir(workDir, rec);
  if (!abs) return out;
  const rel = relProjectPath(workDir, abs);
  if (rel !== null) out.projectPath = rel;
  else out.projectDir = abs;
  return out;
}

module.exports = { relProjectPath, gtdProjectDir, loadProjectRef, storeProjectRef };
