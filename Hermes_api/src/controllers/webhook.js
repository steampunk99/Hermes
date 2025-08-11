// src/controllers/webhookController.js
const { prisma, logger, bridgeContract } = require('../config');
const { ethers } = require('ethers');

exports.handleMMCallback = async (req, res, next) => {
  try {

    const { status, type, trans_id } = req.body;
    
    const jobId = trans_id;
    if (!jobId) {
      logger.warn("Received MM callback with no reference ID");
      return res.status(400).send("No reference ID");
    }
    const mmJob = await prisma.mobileMoneyJob.findUnique({ 
      where: { id: Number(jobId) },
      include: { user: true }
    });
    if (!mmJob) {
      logger.error("MobileMoneyJob not found for ID:", jobId);
      return res.status(404).send("Job not found");
    }
    // Update mmJob status based on callback
    let newStatus;
    if (status === 'SUCCESSFUL') newStatus = 'SUCCESSFUL';
    else if (status === 'PENDING') newStatus = 'PENDING';
    else if (status === 'FAILED') newStatus = 'FAILED';
    else newStatus = status || 'UNKNOWN';
    await prisma.mobileMoneyJob.update({
      where: { id: mmJob.id },
      data: {
        status: newStatus,
        trans_id: String(trans_id)
      }
    });


    // Deposit flow: on SUCCESSFUL collection, mint to user's wallet via Bridge
    if (mmJob && mmJob.type === 'DEPOSIT' && status === 'SUCCESSFUL') {
      const txRecord = await prisma.transaction.findFirst({ where: { mmJobId: mmJob.id } });
      if (txRecord && txRecord.type === 'MINT') {
        const ugdxAmount = txRecord.ugdxAmount;
        try {
          // Use Bridge contract to mint tokens to user (Bridge updates reserves internally)
          const amountBN = ethers.parseUnits(ugdxAmount.toString(), 18);
          const mintTx = await bridgeContract.mintTo(mmJob.user.walletAddress, amountBN);
          const receipt = await mintTx.wait();
          logger.info(`Minted ${ugdxAmount} UGDX to ${mmJob.user.walletAddress} via Bridge (txHash: ${mintTx.hash}).`);
          // Mark transaction as completed with the on-chain tx hash
          await prisma.transaction.update({
            where: { id: txRecord.id },
            data: { status: "COMPLETED", txHash: mintTx.hash }
          });
        } catch (err) {
          logger.error("Minting UGDX via Bridge contract failed:", err);
        }
      }
    }

    // Withdrawal flow: if DISBURSE succeeded, mark related transactions as completed
    if (mmJob.type === 'WITHDRAW' && newStatus === 'SUCCESSFUL') {
      const txRecords = await prisma.transaction.findMany({ where: { mmJobId: mmJob.id } });
      for (let tx of txRecords) {
        // Mark each related transaction as completed
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { status: "COMPLETED" }
        });
      }
    }
    logger.info(`Processed MM callback for job ${jobId}: status ${newStatus} type ${type}`);
    return res.status(200).send("Callback processed");
  } catch (err) {
    next(err);
  }
};
