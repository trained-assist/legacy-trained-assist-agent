'use strict';

// Pure decision logic for GET /capabilities' skills[] list — split out so the
// hh-extracted branch (issue #942) can be unit-tested without depending on
// whether the trained-assist-hh-skill sibling checkout actually exists on
// disk. CI checks out only this repo, so that fs.existsSync() is always
// false there — a real fact about the CI environment, not something to
// paper over in the integration test. Mirrors the resolveToolSource pattern
// in src/mcp-action.js.

const SKILL_NAMES = {
  '10-nalog.js': 'nalog', '20-tilda.js': 'tilda', '21-browser-session.js': 'browser',
  '30-weeek.js': 'weeek', '40-company.js': 'company', '50-gdrive.js': 'gdrive',
  '60-github.js': 'github', '70-inn-enrichment.js': 'inn', '80-getcourse.js': 'getcourse',
};

// toolFilenames: contents of mcp-skills/tools/ (local skills only — hh was extracted).
// hhSkillExtractedPresent: whether the extracted hh-skills sibling repo is checked out.
// freelanceSkillExtractedPresent: whether the freelance-skills sibling repo is checked out.
function computeSkillsList(toolFilenames, hhSkillExtractedPresent, freelanceSkillExtractedPresent) {
  const skills = toolFilenames.map(f => SKILL_NAMES[f]).filter(Boolean);
  if (hhSkillExtractedPresent) skills.push('hh');
  if (freelanceSkillExtractedPresent) skills.push('freelance');
  return skills;
}

module.exports = { computeSkillsList, SKILL_NAMES };
