const express = require('express');
const router = express.Router();

const p2p = require('../controllers/p2p');

// P2P Endpoints (all should be mounted behind auth middleware in index.js)
router.post('/send-onchain', p2p.sendOnChain);
router.post('/send-to-mobile', p2p.sendToMobile);
router.post('/quote-batch', p2p.quoteBatch);
router.post('/send-onchain-batch', p2p.sendOnChainBatch);
router.get('/history', p2p.getHistory);
router.get('/analytics', p2p.getAnalytics); // admin-only inside controller

module.exports = router;
