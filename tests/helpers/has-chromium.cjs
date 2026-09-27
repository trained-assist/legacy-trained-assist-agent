'use strict';
// Browser tests need Playwright's Chromium (`npx playwright install chromium`, done in CI).
// Locally it is often missing — skip those tests with this reason instead of failing.
const fs = require('fs');
let hasChromium = false;
try { hasChromium = fs.existsSync(require('playwright').chromium.executablePath()); } catch { hasChromium = false; }
const NO_CHROMIUM = 'Playwright Chromium not installed (npx playwright install chromium)';
module.exports = { hasChromium, NO_CHROMIUM };
