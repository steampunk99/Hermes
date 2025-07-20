
const { ethers } = require('ethers');
const { prisma, logger } = require('../config');


const bridgeAddress = process.env.BRIDGE_CONTRACT_ADDRESS;
const oracleAddress = process.env.ORACLE_CONTRACT_ADDRESS;
const wsUrl = process.env.RPC_WS_URL;  // WebSocket RPC endpoint for chain

// Define minimal ABIs for the events we need to listen to
const bridgeEventABI = [
  "event USDTSwappedForUGDX(address indexed user, uint256 usdtAmount, uint256 ugdxAmount, uint256 feeAmount, uint256 exchangeRate)",
  "event UGDXBurnedForWithdrawal(address indexed user, uint256 ugdxAmount, uint256 timestamp)"
];
const oracleEventABI = [
  "event PriceUpdated(uint256 indexed oldRate, uint256 indexed newRate, uint256 timestamp, address indexed updater)"
];

// Initialize WebSocket provider and contract interfaces
let wsProvider;
let bridgeWs;
let oracleWs;

/**
 * Start listening to blockchain events with auto-reconnect.
 */
function initEventListeners() {
  wsProvider = new ethers.providers.WebSocketProvider(wsUrl);
  bridgeWs = new ethers.Contract(bridgeAddress, bridgeEventABI, wsProvider);
  oracleWs = new ethers.Contract(oracleAddress, oracleEventABI, wsProvider);

  // Listen for USDT → UGDX swap events
  bridgeWs.on('USDTSwappedForUGDX', async (user, usdtAmount, ugdxAmount, feeAmount, exchangeRate, event) => {
    try {
      logger.info(`Event USDTSwappedForUGDX: ${user} swapped ${usdtAmount} USDT for ${ugdxAmount} UGDX (fee ${feeAmount})`);
      // Convert values to human-readable numbers
      const usdtValue = parseFloat(ethers.utils.formatUnits(usdtAmount, 6));
      const ugdxValue = parseFloat(ethers.utils.formatUnits(ugdxAmount, 18));
      // Find the corresponding user in the database
      const dbUser = await prisma.user.findUnique({ where: { walletAddress: user } });
      if (!dbUser) {
        logger.warn(`Swap event for unknown user ${user}, skipping DB record.`);
        return;
      }
      // Record the swap as a completed MINT transaction in history
      await prisma.transaction.create({
        data: {
          userId: dbUser.id,
          type: "MINT",
          amountUGX: ugdxValue,       // UGX equivalent (1 UGDX = 1 UGX)
          ugdxAmount: ugdxValue,
          txHash: event.transactionHash,
          status: "COMPLETED"
        }
      });
      // (No off-chain action needed since user already received UGDX on-chain)
    } catch (err) {
      logger.error("Error processing USDTSwappedForUGDX event:", err);
    }
  });

  // Listen for UGDX burn events (withdrawals)
  bridgeWs.on('UGDXBurnedForWithdrawal', async (user, ugdxAmount, timestamp, event) => {
    try {
      logger.info(`Event UGDXBurnedForWithdrawal: ${user} burned ${ugdxAmount} UGDX for withdrawal`);
      // Find user and any pending withdrawal/send transactions
      const dbUser = await prisma.user.findUnique({ where: { walletAddress: user } });
      if (!dbUser) {
        logger.error(`Burn event from unknown address ${user}, no action taken.`);
        return;
      }
      // Find pending transactions for this user that correspond to a withdrawal/send
      const pendingTxs = await prisma.transaction.findMany({
        where: {
          userId: dbUser.id,
          status: "PENDING",
          OR: [ { type: "REDEEM" }, { type: "SEND" } ]
        },
        include: { mmJob: true }
      });
      for (const tx of pendingTxs) {
        // Only trigger payout for advanced flows (no txHash recorded yet)
        if (tx.txHash) {
          // This was a normal user withdrawal (already processed via meta-tx)
          logger.info(`Burn event for tx ${tx.id} already handled (txHash exists). Skipping duplicate payout.`);
          continue;
        }
        // Update the transaction with the on-chain burn tx hash
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { txHash: event.transactionHash }
        });
        // Trigger mobile money payout since tokens have been burned on-chain
        if (tx.mmJobId) {
          const job = tx.mmJob;  // related MobileMoneyJob (type DISBURSE)
          logger.info(`Triggering mobile money payout for job #${job.id} after on-chain burn confirmation.`);
          // Call the mobile money service to disburse funds (advanced withdrawal)
          await prisma.mobileMoneyJob.update({
            where: { id: job.id },
            data: { status: "PENDING" }  // ensure status is set to PENDING (awaiting provider)
          });
          await require('../services/mmService').requestWithdrawal({
            amount: job.amount, 
            phone: job.phone, 
            trans_id: job.id.toString()
          });
        }
      }
    } catch (err) {
      logger.error("Error processing UGDXBurnedForWithdrawal event:", err);
    }
  });

  // Listen for price update events from the Oracle (ethers v6 syntax)
  logger.info('Subscribing to Oracle PriceUpdated events (ethers v6)...');
  oracleWs.on('PriceUpdated', async (log) => {
    try {
      const { oldRate, newRate, timestamp, updater } = log.args;
      logger.info('Oracle PriceUpdated event received:', {
        oldRate: oldRate.toString(),
        newRate: newRate.toString(),
        timestamp: timestamp.toString(),
        updater
      });
      const oldRateVal = parseFloat(ethers.utils.formatUnits(oldRate, 18));
      const newRateVal = parseFloat(ethers.utils.formatUnits(newRate, 18));
      const time = new Date(Number(timestamp) * 1000);
      logger.info(`Event PriceUpdated: rate changed from ${oldRateVal} to ${newRateVal} UGX/USD at ${time.toISOString()}`);
      // Upsert the latest price in the database for caching/monitoring
      await prisma.oraclePrice.upsert({
        where: { id: 1 },
        update: { currentRate: newRateVal, lastUpdated: time },
        create: { id: 1, currentRate: newRateVal, lastUpdated: time }
      });
    } catch (err) {
      logger.error("Error processing PriceUpdated event:", err);
    }
  });
  oracleWs.on('error', err => {
    logger.error('OracleWs contract event error:', err);
  });
  oracleWs.on('close', () => {
    logger.error('OracleWs contract event stream closed.');
  });

  // Handle WebSocket connection errors and auto-reconnect
  wsProvider._websocket.on('close', code => {
    logger.error(`Blockchain WS connection closed (code ${code}). Reconnecting in 5s...`);
    reconnect();
  });
  wsProvider._websocket.on('error', err => {
    logger.error("Blockchain WS error:", err);
  });
}

/**
 * Reconnect the WebSocket provider and reattach event listeners.
 */
function reconnect() {
  // Remove existing listeners to avoid duplication
  if (bridgeWs) bridgeWs.removeAllListeners();
  if (oracleWs) oracleWs.removeAllListeners();
  setTimeout(() => {
    initEventListeners();
  }, 5000);
}

module.exports = { initEventListeners };
