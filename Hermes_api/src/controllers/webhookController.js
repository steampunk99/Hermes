// src/controllers/webhookController.js
const { prisma, logger } = require('../config');

exports.handleMMCallback = async (req, res, next) => {
  try {
    // Assume provider sends JSON with at least: externalId or reference (we used jobId as external reference), status, maybe transaction details.
    const { status, type, trans_id } = req.body;
    // externalId or reference should correspond to our MobileMoneyJob ID
    const jobId = trans_id;
    if (!jobId) {
      logger.warn("Received MM callback with no reference ID");
      return res.status(400).send("No reference ID");
    }
    const mmJob = await prisma.mobileMoneyJob.findUnique({ where: { id: Number(jobId) } });
    if (!mmJob) {
      logger.error("MobileMoneyJob not found for ID:", jobId);
      return res.status(404).send("Job not found");
    }
    // Update mmJob status based on callback
    let newStatus;
    if (status === 'SUCCESSFUL') {
      newStatus = 'SUCCESSFUL';
    } else if (status === 'PENDING') {
      newStatus = 'PENDING';
    
    } else if (status === 'FAILED') {
      newStatus = 'FAIL';
    } else {
      newStatus = status || 'UNKNOWN';
    }
    await prisma.mobileMoneyJob.update({
      where: { id: mmJob.id },
      data: {
        status: newStatus,
        externalRef: trans_id  
      }
    });
    // If the job was a deposit (COLLECT) and succeeded, mint UGDX to user on-chain
    if (mmJob.type === 'COLLECT' && newStatus === 'SUCCESSFUL') {
      // Calculate UGDX amount to mint from amountUGX (job.amountUGX is gross or net?)
      // In our record, mmJob.amountUGX is the requested amount. We calculated net and stored in transaction. 
      const txRecord = await prisma.transaction.findFirst({ where: { mmJobId: mmJob.id } });
      if (txRecord && txRecord.type === 'MINT') {
        const ugdxAmount = txRecord.ugdxAmount;
        // Mint UGDX to user's wallet
        try {
          const mintTx = await ugdxContract.mint(mmJob.user.walletAddress, ethers.utils.parseUnits(ugdxAmount.toString(), 18));
          await mintTx.wait();
          logger.info(`Minted ${ugdxAmount} UGDX to ${mmJob.userId}'s wallet after MM deposit success.`);
        } catch (err) {
          logger.error("Minting UGDX failed:", err);
        }
        // Update transaction status to COMPLETED
        await prisma.transaction.update({
          where: { id: txRecord.id },
          data: { status: "COMPLETED", txHash: mintTx.hash }
        });
      }
    }
    // If the job was a withdrawal (DISBURSE) and succeeded, finalize the Transaction (which should already have had tokens burned on-chain)
    if (mmJob.type === 'DISBURSE' && newStatus === 'SUCCESS') {
      const txRecords = await prisma.transaction.findMany({ where: { mmJobId: mmJob.id } });
      for (let tx of txRecords) {
        // Mark each related transaction as completed
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { status: "COMPLETED" }
        });
      }
    }
    logger.info(`Processed MM callback for job ${jobId}: status ${newStatus}`);
    return res.status(200).send("Callback processed");
  } catch (err) {
    next(err);
  }
};
