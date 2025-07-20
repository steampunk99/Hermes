// File: src/jobs/oracleRateJob.js
const cron = require('node-cron');
const axios = require('axios');
const { formatUnits, parseUnits } = require('ethers');
const { logger, prisma, oracleContract } = require('../config');

// Set up hourly cron task to update exchange rate
function startOracleRateJob() {
  // Schedule to run at the top of every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await updateExchangeRate();
    } catch (err) {
      logger.error("Oracle rate update job failed:", err.message);
    }
  });
  logger.info("Scheduled hourly Oracle rate update job.");
}

/**
 * Fetch the latest USD/UGX rate and update the Oracle contract.
 */
async function updateExchangeRate() {
  try {
    // Check if enough time has passed since last update
    const [, lastUpdateTime] = await oracleContract.getLatestPrice();
    const now = Math.floor(Date.now() / 1000);
    const minInterval = 300; // 5 minutes, matching Oracle contract's MIN_PRICE_CHANGE_INTERVAL

    if (lastUpdateTime && (now - Number(lastUpdateTime)) < minInterval) {
      logger.info(`Skipping update: Last update was ${now - Number(lastUpdateTime)} seconds ago. Must wait ${minInterval} seconds between updates.`);
      return;
    }

    const apiKey = process.env.EXCHANGE_RATE_API_KEY;
    if (!apiKey) {
      logger.error("EXCHANGE_RATE_API_KEY not configured");
      return;
    }

    const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/USD/UGX`;
    
    // Fetch current rate from external API
    const { data } = await axios.get(url);
    if (!data || !data.conversion_rate) {
      logger.error("Invalid response from exchange rate API");
      return;
    }
    
    const rateFloat = data.conversion_rate;             // e.g. 3700.25 UGX per USD
    const newRate = parseUnits(rateFloat.toString(), 18);  // BigNumber with 18 decimals
    logger.info(`Fetched USD/UGX rate: ${rateFloat}`);

    // Get last on-chain rate for comparison (to enforce max 5% change rule)
    let lastRate;
    try {
      const [currentRate] = await oracleContract.getLatestPrice();
      lastRate = currentRate;
    } catch (err) {
      // Fallback to DB cache if on-chain fetch fails
      const cache = await prisma.oraclePrice.findUnique({ where: { id: 1 } });
      if (cache) {
        lastRate = parseUnits(cache.currentRate.toString(), 18);
      }
    }

    if (lastRate) {
      // Calculate change in basis points (parts per 10,000) to check 5% threshold
      const diff = newRate > lastRate ? newRate - lastRate : lastRate - newRate;
      const changeBps = Number((diff * BigInt(10000)) / lastRate);
      const changePercent = changeBps / 100;  // in %
      if (changeBps > 500) {  // more than ±5.00% change
        logger.warn(`Exchange rate change ${changePercent}% exceeds 5% threshold. Skipping on-chain update.`);
        return;
      }
    }

    // Update price on-chain via Oracle contract
    const tx = await oracleContract.updatePrice(newRate);
    await tx.wait();
    logger.info(`Oracle contract updatePrice called (tx: ${tx.hash}), new rate = ${rateFloat} UGX/USD`);

    // Update local cache in DB
    await prisma.oraclePrice.upsert({
      where: { id: 1 },
      update: { currentRate: rateFloat, lastUpdated: new Date() },
      create: { id: 1, currentRate: rateFloat, lastUpdated: new Date() }
    });
  } catch (error) {
    // Handle specific error types
    if (error.message.includes("Update too frequent")) {
      logger.info("Skipping update: Update attempted too soon after last update");
    } else if (error.message.includes("Unauthorized updater")) {
      logger.error("Error: Oracle contract hasn't authorized this account as an updater");
    } else {
      logger.error("Oracle update failed:", error.message);
    }
  }
}

module.exports = { startOracleRateJob, updateExchangeRate };
