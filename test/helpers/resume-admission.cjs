const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real admission policy with an in-memory auth boundary: restart tests
// must neither read host authorization nor change the running agent's flags.
module.exports = function resumeAdmission({ blocked = false, profileEngine = 'opencode' } = {}) {
  const sandbox = {
    module: { exports: {} }, process: { env: {} },
    require(name) {
      if (name !== './auth-flag') throw new Error(`Unexpected admission dependency: ${name}`);
      return {
        authGate: () => ({ blocked, suspended: blocked }),
        getAuthFlag: () => ({ suspended: blocked }),
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/engine-admission.js'), 'utf8'), sandbox);
  return {
    resolveEngine: sandbox.module.exports.resolveEngine,
    profiles: { getEngine: () => profileEngine },
    chatFallbackEngine: () => 'codex',
  };
};
