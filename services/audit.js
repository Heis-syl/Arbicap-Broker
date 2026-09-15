'use strict';
const { logger } = require('./logger');
async function auditLog(entry) {
  logger.info(`Audit: ${JSON.stringify(entry)}`);
}
module.exports = { auditLog };
