
const { bridgeContract } = require('../config');
const { ethers } = require('ethers');

const { updateExchangeRate } = require('../jobs/oracleRate');
const { oracleContract } = require('../config');


exports.getBridgeStatus = async (req, res) => {
  try {
    // Fetch comprehensive status from the Bridge contract
    const [rateBN, rateSource, rateTimestamp, rateValid, oracleHealthy, reservesBN, mintedBN, feeBps, isPaused] =
      await bridgeContract.getBridgeStatus();  // single call returns all key metrics:contentReference[oaicite:4]{index=4}:contentReference[oaicite:5]{index=5}
    const currentRate = parseFloat(ethers.utils.formatUnits(rateBN, 18));
    const source = rateSource.toNumber() === 1 ? "oracle" : "manual";
    const totalUSDTReserves = parseFloat(ethers.utils.formatUnits(reservesBN, 6));
    const totalUGDXMinted = parseFloat(ethers.utils.formatUnits(mintedBN, 18));
    return res.json({
      paused: isPaused,
      currentRate,
      rateSource: source,
      oracleMode: rateSource.toNumber() === 1,
      oracleHealthy: oracleHealthy,
      swapFeePercent: feeBps.toNumber() / 100.0,   // e.g. 50 => 0.50%
      totalUSDTReserves,
      totalUGDXMinted
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch bridge status", details: err.message });
  }
};

exports.getReservesStatus = async (req, res) => {
  try {
    // Query on-chain reserves and supply
    const reservesBN = await bridgeContract.totalUSDTReserves();
    const mintedBN = await bridgeContract.totalUGDXMinted();
    const rateBN = await bridgeContract.ugxPerUSD();
    const reservesUSDT = parseFloat(ethers.utils.formatUnits(reservesBN, 6));
    const supplyUGX = parseFloat(ethers.utils.formatUnits(mintedBN, 18));
    const manualRate = parseFloat(ethers.utils.formatUnits(rateBN, 18));
    // Calculate collateralization ratio: USDT reserves vs UGDX supply (in USD terms)
    let collateralRatio = supplyUGX > 0 ? ((reservesUSDT / (supplyUGX / manualRate)) * 100).toFixed(2) + '%' : 'N/A';
    return res.json({
      usdtReserves: reservesUSDT,
      ugdxSupply: supplyUGX,
      collateralRatio
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch reserves status", details: err.message });
  }
};




exports.triggerUpdateRate = async (req, res) => {
  try {
    await updateExchangeRate();
    return res.json({ message: "Oracle price update triggered successfully." });
  } catch (err) {
    logger.error("Manual oracle update failed:", err);
    return res.status(500).json({ error: "Oracle update failed", details: err.message });
  }
};

exports.getOracleHealth = async (req, res) => {
  try {
    const [rateBN, lastTs, isValid] = await oracleContract.getLatestPrice();
    const oracleHealthy = await oracleContract.isOracleHealthy();
    const currentRate = parseFloat(ethers.utils.formatUnits(rateBN, 18));
    const lastUpdate = new Date(lastTs.toNumber() * 1000);
    // Calculate how old the price is (in seconds)
    const now = Date.now();
    const ageSeconds = Math.floor((now - lastUpdate.getTime()) / 1000);
    return res.json({
      currentRate,
      lastUpdate: lastUpdate.toISOString(),
      priceIsFresh: isValid,
      oracleHealthy: oracleHealthy,
      priceAgeSeconds: ageSeconds
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch oracle health", details: err.message });
  }
};
