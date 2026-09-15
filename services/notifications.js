'use strict';
const { logger } = require('./logger');
async function notifyUser(userId, type, title, data = {}) {
  logger.info(`Notification → user:${userId} [${type}] ${title}`);
}
module.exports = { notifyUser };
