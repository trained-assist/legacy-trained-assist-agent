// Contract test for the agent-project-notes.md layer (Hermes Phase 2). Mirrors
// profile-tier agent-notes.md but scoped
// per project — must not leak across sibling projects and must never be seeded empty.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const projects = require('../src/projects');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-notes-test-'));

const a = projects.createProject(workDir, 'Проект A');
const b = projects.createProject(workDir, 'Проект B');

ok(projects.notesText(workDir, a.id) === null, 'no notes file yet -> null, not empty string');
ok(!fs.existsSync(projects.notesPath(workDir, a.id)), 'agent-project-notes.md is never seeded on create');

fs.writeFileSync(projects.notesPath(workDir, a.id), '- клиент предпочитает короткие письма\n');
ok(projects.notesText(workDir, a.id) === '- клиент предпочитает короткие письма', 'reads back trimmed content');
ok(projects.notesText(workDir, b.id) === null, 'sibling project does not see project A notes (no cross-project leak)');
ok(projects.notesText(workDir, 'no-such-id') === null, 'unknown project id -> null');
ok(projects.notesText(workDir, null) === null, 'no project bound -> null');

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\nprojects-notes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
