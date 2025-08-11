// src/utils/gas.js
const { ethers } = require('ethers');
const { prisma, logger, provider } = require('../config');

/**
 * Deduct gas credit for a user based on actual gas used.
 * Ethers v6-safe bigint handling. Records a GasDrip entry with type "USE".
 *
 * @param {Object} params
 * @param {Object} params.user - Prisma User record
 * @param {Object} params.receipt - ethers v6 tx receipt (must include gasUsed, effectiveGasPrice if available)
 * @param {Object} [params.tx] - optional tx object (may include gasPrice)
 * @param {string} [params.note] - context note
 */
async function deductGasCredit({ user, receipt, tx, note }) {
  try {
    if (!user || !receipt) return;

    const gasUsed = BigInt(receipt.gasUsed);
    let gasPriceBig;
    if (receipt.effectiveGasPrice != null) {
      gasPriceBig = BigInt(receipt.effectiveGasPrice);
    } else if (tx && tx.gasPrice != null) {
      gasPriceBig = BigInt(tx.gasPrice);
    } else {
      const gp = await provider.getGasPrice();
      gasPriceBig = BigInt(gp);
    }

    const costWei = gasUsed * gasPriceBig;
    const costInEth = ethers.formatEther(costWei);
    // TODO: replace constant with oracle-derived rate
    const costUGX = parseFloat(costInEth) * 3700;

    const currentCredit = parseFloat(user.gasCredit || 0);
    const newCredit = Math.max(currentCredit - costUGX, 0);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { gasCredit: newCredit } }),
      prisma.gasDrip.create({ data: { userId: user.id, amount: costUGX, type: 'USE', note } })
    ]);
  } catch (e) {
    logger.error('Failed to record GasDrip usage', { error: e.message, txHash: receipt?.transactionHash });
  }
}

module.exports = { deductGasCredit };
