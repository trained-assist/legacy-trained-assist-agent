'use strict';

// site_deploy — publish a multi-file static site (catalog, landing, report with
// assets) to Cloudflare Pages. publish_page covers single pages; this is for
// whole folders. Runs server-side so the Cloudflare token never reaches the
// agent process (issue #1774, see src/cf-pages.js for token resolution:
// the profile's own token first, the shared default otherwise).

const { deploySite, deployStatus } = require('../../cf-pages');

const USER_ID = process.env.USER_ID || '';

module.exports = {
  tools: {
    site_deploy: {
      description:
        'Publish a static site folder (must contain index.html, must be inside the profile workspace) to Cloudflare Pages and to the branded domain. ' +
        'Result `url` = the link to give the user: https://recruiter-assistant.ru/s/<project>/ (branded copy, main branch); `pages_dev_url` is the raw Cloudflare fallback — do not hand it out when `url` is branded. ' +
        'Use relative links inside the site (the branded copy lives under /s/<project>/). ' +
        'Use instead of running `npx wrangler pages deploy` yourself — the agent process has no Cloudflare credentials. ' +
        'Token: the profile\'s own (connect({service:"cloudflare"})) if connected, otherwise the shared default account. ' +
        'On the shared account a project name belongs to the profile that created it; a name taken by another profile is refused — pick another. ' +
        'Creates the project if missing. For a single page use publish_page.',
      inputSchema: {
        type: 'object',
        required: ['dir', 'project'],
        properties: {
          dir: { type: 'string', description: 'Folder with index.html; absolute or relative to the profile workspace.' },
          project: { type: 'string', description: 'Pages project name (lowercase latin, digits, hyphen) — becomes <project>.pages.dev.' },
          branch: { type: 'string', description: 'Branch label; "main" (default) = production URL.' },
        },
      },
      handler: async ({ dir, project, branch } = {}, ctx) =>
        deploySite({ username: ctx?.userId || USER_ID, dir, project, branch: branch || 'main' }),
    },

    site_deploy_status: {
      description: 'Which Cloudflare token site_deploy would use for this profile ("own" or "shared") and the account id. Never returns the token.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => deployStatus(ctx?.userId || USER_ID),
    },
  },
};
