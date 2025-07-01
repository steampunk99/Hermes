// File: src/jobs/oracleRateJob.js
const cron = require('node-cron');
const fetch = require('node-fetch');
const { ethers } = require('ethers');
const { logger, prisma, oracleContract } = require('../config');

// Set up hourly cron task to update exchange rate
function startOracleRateJob() {
  // Schedule to run at the top of every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await updateExchangeRate();
    } catch (err) {
      logger.error("Oracle rate update job failed:", err);
    }
  });
  logger.info("Scheduled hourly Oracle rate update job.");
}

/**
 * Fetch the latest USD/UGX rate and update the Oracle contract.
 */
async function updateExchangeRate() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/USD/UGX`;
  // Fetch current rate from external API
  const response = await fetch(url);
  const data = await response.json();
  if (!data || !data.conversion_rate) {
    throw new Error("Invalid response from exchange rate API");
  }
  const rateFloat = data.conversion_rate;             // e.g. 3700.25 UGX per USD
  const newRate = ethers.utils.parseUnits(rateFloat.toString(), 18);  // BigNumber with 18 decimals
  logger.info(`Fetched USD/UGX rate: ${rateFloat}`);

  // Get last on-chain rate for comparison (to enforce max 5% change rule)
  let lastRate;
  try {
    const [currentRate] = await oracleContract.getLatestPrice();
    lastRate = currentRate;
  } catch {
    // Fallback to DB cache if on-chain fetch fails
    const cache = await prisma.oraclePrice.findUnique({ where: { id: 1 } });
    if (cache) {
      lastRate = ethers.utils.parseUnits(cache.currentRate.toString(), 18);
    }
  }
  if (lastRate) {
    // Calculate change in basis points (parts per 10,000) to check 5% threshold
    const diff = newRate.gt(lastRate) ? newRate.sub(lastRate) : lastRate.sub(newRate);
    const changeBps = diff.mul(10000).div(lastRate).toNumber();
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
}

module.exports = { startOracleRateJob, updateExchangeRate };
