'use strict';

// Example read-only tool — replace with the {{domainName}} domain tools.
module.exports = {
  tools: {
    example_status: {
      description: 'Example read-only status tool for the {{domainName}} domain skill.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true, domain: '{{domain}}' }),
    },
  },
};
