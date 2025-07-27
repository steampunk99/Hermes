const { eventProcessor } = require('./eventProcessor');
const p2pEventProcessor = require('./p2pEventProcessor');
const { logger } = require('../config');

/**
 * Initialize hybrid blockchain event processing system
 */
async function initEventListeners() {
  try {
    logger.info('☯️ Initializing event listeners...');
    await eventProcessor.initialize();
    
    // Initialize P2P event listeners
    p2pEventProcessor.initP2PEventListeners();
    
    logger.info('☯️ Event listeners initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize ☯️:', error);
    throw error;
  }
}

module.exports = { initEventListeners };
