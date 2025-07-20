
const { bridgeContract, oracleContract, relayer, logger } = require('../config');
const { formatUnits } = require('ethers');
const { updateExchangeRate } = require('../jobs/oracleRate');


exports.getBridgeStatus = async (req, res) => {
  try {
    // Fetch comprehensive status from the Bridge contract
    const [rateBN, rateSourceRaw, rateTimestamp, rateValid, oracleHealthy, reservesBN, mintedBN, feeBps, isPaused] =
      await bridgeContract.getBridgeStatus();
    const currentRate = parseFloat(formatUnits(rateBN.toString(), 18));
    const totalUSDTReserves = parseFloat(formatUnits(reservesBN.toString(), 6));
    const totalUGDXMinted = parseFloat(formatUnits(mintedBN.toString(), 18));
    // Always get oracleMode directly from contract
    const oracleMode = await bridgeContract.useOracleForPricing();
    // Set rateSource based on oracleMode
    const rateSource = oracleMode ? "oracle" : "manual";
    return res.json({
      paused: isPaused,
      currentRate,
      rateSource,
      oracleMode,
      oracleHealthy,
      swapFeePercent: Number(feeBps) / 10000,   // 50 => 0.0050
      totalUSDTReserves,
      totalUGDXMinted
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch bridge status", details: err.message });
  }
};

exports.getReservesStatus = async (req, res) => {
  try {
    // Get all values from getBridgeStatus
    const [rateBN, , , , , reservesBN, mintedBN] = await bridgeContract.getBridgeStatus();
    const reservesUSDT = parseFloat(formatUnits(reservesBN.toString(), 6));
    const supplyUGX = parseFloat(formatUnits(mintedBN.toString(), 18));
    const manualRate = parseFloat(formatUnits(rateBN.toString(), 18));
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
    // Get Oracle details
    const [rateBN, lastTs, isValid] = await oracleContract.getLatestPrice();
    const oracleHealthy = await oracleContract.isOracleHealthy();
    const currentRate = parseFloat(formatUnits(rateBN.toString(), 18));
    const lastUpdate = new Date(Number(lastTs) * 1000);
    const now = Date.now();
    const ageSeconds = Math.floor((now - lastUpdate.getTime()) / 1000);

    // Get Bridge details
    const bridgeOracleAddress = await bridgeContract.priceOracle();
    const bridgeOwner = await bridgeContract.owner();
    const bridgeUsingOracle = await bridgeContract.useOracleForPricing();

    // Get authorization status
    const relayerAddress = await relayer.getAddress();
    const isUpdater = await oracleContract.isAuthorizedUpdater(relayerAddress);
    const oracleOwner = await oracleContract.owner();

    return res.json({
      oracle: {
        address: oracleContract.target,
        owner: oracleOwner,
        currentRate,
        lastUpdate: lastUpdate.toISOString(),
        priceIsFresh: isValid,
        oracleHealthy,
        priceAgeSeconds: ageSeconds,
        isRelayerAuthorized: isUpdater
      },
      bridge: {
        address: bridgeContract.target,
        owner: bridgeOwner,
        configuredOracleAddress: bridgeOracleAddress,
        usingOracleForPricing: bridgeUsingOracle
      },
      relayer: {
        address: relayerAddress
      }
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch oracle health", details: err.message });
  }
};

exports.setOracleMode = async (req, res) => {
  try {
    // Check ownership
    const owner = await bridgeContract.owner();
    const relayerAddress = await relayer.getAddress();
    
    if (owner.toLowerCase() !== relayerAddress.toLowerCase()) {
      return res.status(403).json({ 
        error: "Permission denied", 
        details: `Relayer ${relayerAddress} is not the bridge owner (${owner})`
      });
    }

    // Check if oracle address is set
    const oracleAddress = await bridgeContract.priceOracle();
    if (oracleAddress === "0x0000000000000000000000000000000000000000") {
      return res.status(400).json({ 
        error: "Oracle not configured", 
        details: "Oracle address is not set in bridge contract" 
      });
    }

    // Check if oracle is healthy
    const isHealthy = await oracleContract.isOracleHealthy();
    if (!isHealthy) {
      return res.status(400).json({ 
        error: "Cannot enable oracle pricing", 
        details: "Oracle is not healthy" 
      });
    }

    // Set oracle pricing mode to true
    const tx = await bridgeContract.setOraclePricingMode(true);
    await tx.wait();

    logger.info("Oracle pricing mode enabled successfully");
    return res.json({ 
      message: "Oracle pricing mode enabled",
      transaction: tx.hash
    });
  } catch (err) {
    logger.error("Failed to enable oracle pricing:", err.message);
    return res.status(500).json({ error: "Failed to enable oracle pricing", details: err.message });
  }


};

exports.disableOracleMode = async (req, res) => {
  try {
    // Check ownership
    const owner = await bridgeContract.owner();
    const relayerAddress = await relayer.getAddress();
    
    if (owner.toLowerCase() !== relayerAddress.toLowerCase()) {
      return res.status(403).json({ 
        error: "Permission denied", 
        details: `Relayer ${relayerAddress} is not the bridge owner (${owner})`
      });
    }

    // Set oracle pricing mode to false
    const tx = await bridgeContract.setOraclePricingMode(false);
    await tx.wait();

    logger.info("Oracle pricing mode disabled successfully");
    return res.json({ 
      message: "Oracle pricing mode disabled",
      transaction: tx.hash
    });
  } catch (err) {
    logger.error("Failed to disable oracle pricing:", err.message);
    return res.status(500).json({ error: "Failed to disable oracle pricing", details: err.message });
  }
};