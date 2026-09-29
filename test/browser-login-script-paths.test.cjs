'use strict';
// #1875: login-server.js must run the shipped login.js, never the hand copy in ~/browser-session
// (which nothing redeploys and still reports success on rejected credentials — the #1866 bug).
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { resolveShipped } = require('../infra/browser-session/script-paths.js');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const here = path.join(__dirname, '..', 'infra', 'browser-session');

// 1. The shipped login.js exists in the repo → resolver returns the shipped path.
const login = resolveShipped('login.js');
ok(login === path.join(here, 'login.js'), 'login.js resolves to the shipped copy');
ok(!login.startsWith(path.join(os.homedir(), 'browser-session')),
   'shipped login.js is NOT the ~/browser-session hand copy');

// 2. Shipped file must carry the #1866 fix (delegates outcome to login-outcome.js).
const loginSrc = fs.readFileSync(login, 'utf8');
ok(loginSrc.includes('login-outcome'), 'shipped login.js uses login-outcome (post-#1866)');

// 3. Fallback keeps a legacy install working: a name with no shipped copy → homedir.
const legacy = resolveShipped('__no_such_script__.js');
ok(legacy === path.join(os.homedir(), 'browser-session', '__no_such_script__.js'),
   'missing shipped script falls back to ~/browser-session');

// 4. login-server.js must consume the resolver for BOTH scripts — regression guard.
const serverSrc = fs.readFileSync(path.join(here, 'login-server.js'), 'utf8');
ok(/LOGIN_SCRIPT\s*=\s*resolveShipped\('login\.js'\)/.test(serverSrc),
   'login-server resolves LOGIN_SCRIPT via resolveShipped');
ok(/CAPTURE_SCRIPT\s*=\s*resolveShipped\('capture-cookies\.js'\)/.test(serverSrc),
   'login-server resolves CAPTURE_SCRIPT via resolveShipped');

console.log(`browser-login-script-paths: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
