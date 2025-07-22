const { eventProcessor } = require('./eventProcessor');
const { logger } = require('../config');

/**
 * Initialize hybrid blockchain event processing system
 */
async function initEventListeners() {
  try {
    logger.info('☯️...');
    await eventProcessor.initialize();
    logger.info('☯️ initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize ☯️:', error);
    throw error;
  }
}

module.exports = { initEventListeners };
