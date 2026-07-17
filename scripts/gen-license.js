#!/usr/bin/env node
/**
 * Generate Agent Micro license keys for Gumroad fulfillment.
 *
 *   node scripts/gen-license.js          # one key
 *   node scripts/gen-license.js 10       # ten keys
 *
 * Use the same secret as the app (AGENT_MICRO_LICENSE_SECRET) when shipping.
 */
const license = require('../src/license');

const count = Math.max(1, Math.min(500, Number(process.argv[2]) || 1));
for (let i = 0; i < count; i++) {
  console.log(license.generateKey());
}
