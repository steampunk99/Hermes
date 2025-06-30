    // src/controllers/transactionController.js
const { prisma, logger, ugdxContract, bridgeContract, forwarderContract, relayer, provider, PROVIDER_FEE_BPS } = require('../config');
const ethers = require('ethers');
const mmService = require('../services/mmService');

// Helper: calculate provider fee and net UGX after fee
function applyProviderFee(amountUgx){
  const fee = (amountUgx * PROVIDER_FEE_BPS) / 10000;
  const net = amountUgx - fee;
  return { fee, net };
}

class TransactionController {


// POST /transactions/mint - user deposits UGX to mint UGDX
async mintUGDX (req, res, next) {
  try {
    const userId = req.user.userId;
    const { amountUGX } = req.body;
    if (!amountUGX || amountUGX <= 0) {
      return res.status(400).json({ error: "Deposit amount must be greater than 0" });
    }
    // Get user and ensure they have a wallet address on file to receive UGDX
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.walletAddress) {
      return res.status(400).json({ error: "No wallet address linked. Please add a crypto wallet address to receive UGDX." });
    }
    const phone = user.phone;  // using user's own phone for deposit by default
  
    // Calculate net UGDX after provider fee
    const { fee, net } = applyProviderFee(amountUGX);
    const ugdxToMint = net;  // 1 UGX -> 1 UGDX (pegged 1:1 for simplicity)
    // Create a MobileMoneyJob entry for collection
    const mmJob = await prisma.mobileMoneyJob.create({
      data: {
        userId,
        phone,
        amountUGX: amountUGX,
        type: "COLLECT",
        provider: providerName,
        status: "PENDING"
      }
    });
    // Create a Transaction entry for mint
    const txn = await prisma.transaction.create({
      data: {
        userId,
        type: "MINT",
        amountUGX: amountUGX,
        ugdxAmount: ugdxToMint,
        status: "PENDING",
        mmJobId: mmJob.id
      }
    });
    // Initiate the mobile money collection via provider API
    const result = await mmService.requestToPay(phone, amount=amountUGX, trans_id);

    if (result.status === 'PENDING') {
      // Simulate waiting for callback... (In reality, this would be handled in webhook route.)
      logger.info(`Initiated UGX collection of ${amountUGX} via ${providerName} for user ${user.email}`);
    }
    // Respond to client with the net UGDX they will receive and transaction status
    return res.status(200).json({ 
      message: "Deposit initiated. You will receive UGDX shortly after the payment is confirmed.",
      netUGDX: ugdxToMint,
      feeUGX: fee,
      transactionId: txn.id
    });
  } catch (err) {
    next(err);
  }
};

// POST /transactions/redeem - user withdraws UGX by burning UGDX
 async redeemUGDX (req, res, next)  {
  try {
    const userId = req.user.userId;
    const { amountUGDX, phone } = req.body;
    if (!amountUGDX || amountUGDX <= 0) {
      return res.status(400).json({ error: "Withdrawal amount must be greater than 0" });
    }
    // Determine target phone: if provided use it, otherwise default to user's own phone on file
    let targetPhone = phone;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
  
    // Check on-chain UGDX balance if possible to ensure user has enough to burn
    if (user.walletAddress) {
      const balance = await ugdxContract.balanceOf(user.walletAddress);
      const balanceUGDX = ethers.utils.formatUnits(balance, 18);
      if (parseFloat(balanceUGDX) < amountUGDX) {
        return res.status(400).json({ error: "Insufficient UGDX balance to redeem that amount." });
      }
    }
    // Calculate provider fee and net UGX user will receive
    const { fee, net } = applyProviderFee(amountUGDX);
    const ugxToDisburse = net;  // 1 UGDX -> 1 UGX conversion
    // Create MobileMoneyJob for disbursement
    const mmJob = await prisma.mobileMoneyJob.create({
      data: {
        userId,
        phone: targetPhone,
        amountUGX: ugxToDisburse,
        type: "DISBURSE",
        provider: providerName,
        status: "PENDING"
      }
    });
    // Create Transaction entry for redeem
    const txn = await prisma.transaction.create({
      data: {
        userId,
        type: "REDEEM",
        amountUGX: ugxToDisburse,
        ugdxAmount: amountUGDX,
        toPhone: targetPhone,
        status: "PENDING",
        mmJobId: mmJob.id
      }
    });
    // Handle on-chain burn via meta-transaction for normal users
    const userRole = req.user.role;
    if (userRole !== 'advanced') {
      // Normal mode: use relayer to burn UGDX on behalf of user via Bridge (meta-tx)
      // In practice, we need user's signature for the meta transaction. For MVP, assume it's provided in request.
      const { signature } = req.body;
      if (!signature) {
        // If signature not provided, we cannot proceed (user must be advanced or have gas to do it themselves).
        return res.status(400).json({ error: "Meta-transaction signature required for gasless withdrawal." });
      }
      // Construct call data for Bridge.burnForWithdrawal(amountUGDX)
      const iface = new ethers.utils.Interface(BRIDGE_ABI);
      const data = iface.encodeFunctionData("burnForWithdrawal", [ ethers.utils.parseUnits(amountUGDX.toString(), 18) ]);
      // Get current nonce for user in forwarder
      const nonce = await forwarderContract.getNonce(user.walletAddress);
      // Execute via forwarder (assuming signature is valid for {from: user.walletAddress, to: Bridge.address, data, nonce})
      try {
        const tx = await forwarderContract.execute(bridgeContract.address, data, user.walletAddress, nonce, signature);
        const receipt = await tx.wait();
        logger.info(`UGDX burn meta-tx sent by relayer, txHash: ${receipt.transactionHash}`);
        // Update transaction record with txHash
        await prisma.transaction.update({
          where: { id: txn.id },
          data: { txHash: receipt.transactionHash }
        });
        // Deduct gas credit: estimate cost and subtract from user.gasCredit
        const gasUsed = receipt.gasUsed;
        const gasPrice = tx.gasPrice || (await provider.getGasPrice());
        const costMatic = gasUsed.mul(gasPrice);
        // Convert gas cost to UGX via some conversion (if available, here assume 1 MATIC ~ $1 ~ 3700 UGX for rough estimate)
        const costUGX = parseFloat(ethers.utils.formatEther(costMatic)) * 3700;
        const newCredit = Math.max(parseFloat(user.gasCredit) - costUGX, 0);
        await prisma.user.update({
          where: { id: userId },
          data: { gasCredit: newCredit }
        });
        // Log gas usage in GasDrip
        await prisma.gasDrip.create({
          data: { userId, amount: costUGX, type: "USE", note: `Redeem tx ${receipt.transactionHash}` }
        });
      } catch (err) {
        logger.error("Meta-tx execution failed:", err);
        return res.status(500).json({ error: "Failed to execute token burn transaction." });
      }
    } else {
      // Advanced mode: user is expected to burn tokens on-chain themselves.
      // We might require a txHash in the request or monitor events. For MVP, just inform user.
      logger.info(`Advanced user ${user.email} requested withdrawal; awaiting on-chain burn.`);
    }
    // Initiate mobile money payout
    await mmService.requestWithdrawal(amount, phone, reason, trans_id);
    // Respond with summary
    return res.status(200).json({
      message: "Withdrawal initiated. UGX will be sent to the target mobile money account shortly.",
      netUGX: ugxToDisburse,
      feeUGX: fee,
      transactionId: txn.id
    });
  } catch (err) {
    next(err);
  }
};

// POST /transactions/send - user sends UGDX to address or phone
 async sendUGDX (req, res, next) {
  try {
    const userId = req.user.userId;
    const { amountUGDX, toAddress, phone, signature } = req.body;
    if (!amountUGDX || amountUGDX <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });
    // Determine if this is an on-chain transfer or a send-to-phone
    if (toAddress && ethers.utils.isAddress(toAddress)) {
      // On-chain transfer case
      // Create transaction record
      const txn = await prisma.transaction.create({
        data: {
          userId,
          type: "SEND",
          amountUGX: amountUGDX,   // treat UGX equivalent same as UGDX for recording
          ugdxAmount: amountUGDX,
          toAddress: toAddress,
          status: "PENDING"
        }
      });
      // If user is normal (needs gasless), require signature for meta-tx
      if (req.user.role !== 'advanced') {
        if (!signature) {
          return res.status(400).json({ error: "Meta-transaction signature required for gasless send." });
        }
        // Prepare data for UGDX.transfer(toAddress, amount)
        const iface = new ethers.utils.Interface(UGDX_ABI);
        const data = iface.encodeFunctionData("transfer", [ toAddress, ethers.utils.parseUnits(amountUGDX.toString(), 18) ]);
        const nonce = await forwarderContract.getNonce(user.walletAddress);
        // Execute via forwarder
        try {
          const tx = await forwarderContract.execute(ugdxContract.address, data, user.walletAddress, nonce, signature);
          const receipt = await tx.wait();
          logger.info(`UGDX transfer meta-tx sent, txHash: ${receipt.transactionHash}`);
          // Update transaction with txHash and mark completed
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { txHash: receipt.transactionHash, status: "COMPLETED" }
          });
          // Deduct gas credit similar to above
          const gasUsed = receipt.gasUsed;
          const gasPrice = tx.gasPrice || (await provider.getGasPrice());
          const costMatic = gasUsed.mul(gasPrice);
          const costUGX = parseFloat(ethers.utils.formatEther(costMatic)) * 3700;
          const newCredit = Math.max(parseFloat(user.gasCredit) - costUGX, 0);
          await prisma.user.update({
            where: { id: userId },
            data: { gasCredit: newCredit }
          });
          await prisma.gasDrip.create({
            data: { userId, amount: costUGX, type: "USE", note: `Send tx ${receipt.transactionHash}` }
          });
        } catch (err) {
          logger.error("Gasless transfer failed:", err);
          return res.status(500).json({ error: "Failed to execute gasless transfer." });
        }
      } else {
        // Advanced user: they will send on-chain themselves. We won't execute anything, just record.
        // Possibly we could accept a txHash from advanced user to confirm, but not required for MVP.
        await prisma.transaction.update({
          where: { id: txn.id },
          data: { status: "COMPLETED" }
        });
      }
      return res.status(200).json({ message: "Transfer successful", transactionId: txn.id });
    } else if (phone) {
      // Send to mobile money (UGX) case
      const targetPhone = phone;
    
      // Ensure user has enough UGDX (if we can check on-chain)
      if (user.walletAddress) {
        const balance = await ugdxContract.balanceOf(user.walletAddress);
        if (parseFloat(ethers.utils.formatUnits(balance, 18)) < amountUGDX) {
          return res.status(400).json({ error: "Insufficient UGDX balance." });
        }
      }
      // Calculate fee and net UGX to send
      const { fee, net } = applyProviderFee(amountUGDX);
      const ugxToSend = net;
      // Create records
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId,
          phone: targetPhone,
          amountUGX: ugxToSend,
          type: "DISBURSE",
          provider: providerName,
          status: "PENDING"
        }
      });
      const txn = await prisma.transaction.create({
        data: {
          userId,
          type: "SEND",
          amountUGX: ugxToSend,
          ugdxAmount: amountUGDX,
          toPhone: targetPhone,
          status: "PENDING",
          mmJobId: mmJob.id
        }
      });
      // Perform on-chain burn of UGDX for the user via meta-tx
      if (req.user.role !== 'advanced') {
        if (!signature) {
          return res.status(400).json({ error: "Signature required for gasless token burn." });
        }
        const iface = new ethers.utils.Interface(BRIDGE_ABI);
        const data = iface.encodeFunctionData("burnForWithdrawal", [ ethers.utils.parseUnits(amountUGDX.toString(), 18) ]);
        const nonce = await forwarderContract.getNonce(user.walletAddress);
        try {
          const tx = await forwarderContract.execute(bridgeContract.address, data, user.walletAddress, nonce, signature);
          const receipt = await tx.wait();
          logger.info(`UGDX burn for send (meta-tx) txHash: ${receipt.transactionHash}`);
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { txHash: receipt.transactionHash }
          });
          // Deduct gas credit (similar to above)
          const gasUsed = receipt.gasUsed;
          const gasPrice = tx.gasPrice || (await provider.getGasPrice());
          const costMatic = gasUsed.mul(gasPrice);
          const costUGX = parseFloat(ethers.utils.formatEther(costMatic)) * 3700;
          const newCredit = Math.max(parseFloat(user.gasCredit) - costUGX, 0);
          await prisma.user.update({ where: { id: userId }, data: { gasCredit: newCredit } });
          await prisma.gasDrip.create({
            data: { userId, amount: costUGX, type: "USE", note: `SendMM tx ${receipt.transactionHash}` }
          });
        } catch (err) {
          logger.error("Meta burn for send failed:", err);
          return res.status(500).json({ error: "Failed to burn tokens for send." });
        }
      } else {
        logger.info(`Advanced user ${user.email} will burn UGDX on-chain for send.`);
      }
      // Initiate mobile money disbursement to target phone
      await mmService.requestWithdrawal(phone, amount, trans_id);
      return res.status(200).json({
        message: "UGX transfer initiated to recipient. They will receive the funds shortly.",
        netUGX: ugxToSend,
        feeUGX: fee,
        transactionId: txn.id
      });
    } else {
      return res.status(400).json({ error: "Invalid request. Specify a toAddress or phone." });
    }
  } catch (err) {
    next(err);
  }
};

// GET /transactions/history - list of user's past transactions
 async getHistory (req, res, next) {
  try {
    const userId = req.user.userId;
    // Fetch transactions for user, most recent first
    const history = await prisma.transaction.findMany({
      where: { userId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        mmJob: true  // include related mobile money job if any (to get phone, provider, etc.)
      }
    });
    return res.json({ history });
  } catch (err) {
    next(err);
  }
};

// GET /rates/current - returns current exchange rates for UGDX
 async getCurrentRates (req, res, next) {
  try {
    // Fetch on-chain rate if available from Oracle or Bridge
    let ugxPerUSD = 3700;
    try {
      const rate = await bridgeContract.ugxPerUSD();
      ugxPerUSD = parseInt(rate.toString()) / 1e18;  // assuming ugxPerUSD stored with 18 decimals
    } catch (err) {
      // If call fails, use default 3700 UGX = 1 USD (example)
    }
    // UGDX is pegged 1:1 to UGX, so 1 UGDX = 1 UGX
    const ugdxPerUGX = 1;
    const usdPerUGX = 1 / ugxPerUSD;
    return res.json({
      ugxPerUSD: ugxPerUSD,
      usdPerUGX: usdPerUGX,
      ugdxPerUGX: ugdxPerUGX
    });
  } catch (err) {
    next(err);
  }
};

}

module.exports = new TransactionController();