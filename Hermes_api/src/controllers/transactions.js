const { prisma, logger, ugdxContract, bridgeContract, forwarderContract, relayer, provider, PROVIDER_FEE_BPS } = require('../config');
const ethers = require('ethers');
const mmService = require('../services/mmService');
const {
  verifyMetaTxSignature,
  executeMetaTx,
  createBridgeBurnMetaTx,
  createUGDXTransferMetaTx,
  getForwarderDomain
} = require('../utils/metaTx');

// Helper: calculate provider fee and net UGX after fee
function applyProviderFee(amountUgx) {
  const fee = (amountUgx * PROVIDER_FEE_BPS) / 10000;
  const net = amountUgx - fee;
  return { fee, net };
}

// Helper: deduct gas credit based on actual gas used by a transaction
async function deductGasCredit(user, tx, receipt, note) {
  const gasUsed = receipt.gasUsed;
  // Use gas price from tx or receipt (handle legacy vs EIP-1559), fallback to provider gas price
  const gasPrice = tx.gasPrice || (receipt.effectiveGasPrice ? receipt.effectiveGasPrice : await provider.getGasPrice());
  const costMatic = gasUsed.mul(gasPrice);
  // Convert gas cost (in MATIC) to ETH string, then to UGX (approximate rate: 1 MATIC ~ 3700 UGX)
  const costMaticInEth = ethers.utils.formatEther(costMatic);
  const costUGX = parseFloat(costMaticInEth) * 3700;
  const newCredit = Math.max(parseFloat(user.gasCredit) - costUGX, 0);
  // Update user's remaining gas credit and log the usage
  await prisma.user.update({ where: { id: user.id }, data: { gasCredit: newCredit } });
  await prisma.gasDrip.create({ data: { userId: user.id, amount: costUGX, type: "USE", note } });
}

class TransactionController {


// POST /transactions/mint - user deposits UGX to mint UGDX
  async mintUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amount } = req.body;  // Changed from amountUGX to amount
      
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Deposit amount must be greater than 0." });
      }
      // Ensure user exists and has a wallet address to receive UGDX
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.walletAddress) {
        return res.status(400).json({ error: "No wallet address linked. Please add a crypto wallet address to receive UGDX." });
      }
      
      logger.info(`☯️ Creating mobile money job for user: ${user.email} (ID: ${user.id}, Wallet: ${user.walletAddress})`);
      const phone = user.phone;  // use user's own phone for deposit
      // Calculate net UGDX after provider fee
      const { fee, net } = applyProviderFee(amount);
      const ugdxToMint = net;  // assuming 1 UGX = 1 UGDX
      // Determine provider based on phone number or user preference
      const providerName = phone.startsWith('077') || phone.startsWith('078') ? 'MTN' : 'AIRTEL';
      
      // Create a MobileMoneyJob entry for collection (deposit)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: phone,
          amount: amount,  // Use parsed amount
          type: "COLLECT",
          provider: providerName,
          status: "PENDING"
        }
      });
      // Create a Transaction entry for this mint operation
      const txn = await prisma.transaction.create({
        data: {
          userId: userId,
          type: "MINT",
          amountUGX: amount,  // Use parsed amount
          ugdxAmount: ugdxToMint,
          status: "PENDING",
          mmJobId: mmJob.id
        }
      });
      // For now, skip Script Networks API call and use manual confirmation
      // TODO: Re-enable when Script Networks webhooks are ready
      // const result = await mmService.requestToPay({
      //   amount: amountUGX,
      //   phone: phone,
      //   trans_id: mmJob.id
      // });

      // console.log(result)
      
      logger.info(`Created manual payment request: ${amount} UGX collection for user ${user.email} (Job #${mmJob.id}). Awaiting admin confirmation.`);
      // Respond to client with net UGDX to be minted and transaction info
      return res.status(200).json({
        message: "Deposit request created. Please send the mobile money payment and contact admin for confirmation.",
        instructions: `Send ${amount} UGX to the mobile money number provided by admin, then contact support with Job ID: ${mmJob.id}`,
        jobId: mmJob.id,
        netUGDX: ugdxToMint,
        feeUGX: fee,
        transactionId: txn.id,
        status: "PENDING"
      });
    } catch (err) {
      next(err);
    }
  };

// POST /transactions/redeem - user withdraws UGX by burning UGDX
  async redeemUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amountUGDX, phone } = req.body;
      if (!amountUGDX || amountUGDX <= 0) {
        return res.status(400).json({ error: "Withdrawal amount must be greater than 0." });
      }
      // Determine target phone: use provided phone or default to user's phone
      const targetPhone = phone || (await prisma.user.findUnique({ where: { id: userId } }))?.phone;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      
      // Check off-chain UGDX credit balance (this is what users redeem from)
      const ugdxCreditBalance = user.ugdxCredit || 0;
      if (ugdxCreditBalance < amountUGDX) {
        return res.status(400).json({ 
          error: "Insufficient UGDX credit balance to redeem that amount.",
          availableBalance: ugdxCreditBalance,
          requestedAmount: amountUGDX
        });
      }
      // Calculate provider fee and net UGX that will be disbursed
      const { fee, net } = applyProviderFee(amountUGDX);
      const ugxToDisburse = net;  // UGX amount to send out (1 UGDX = 1 UGX)
      // Determine provider based on phone number
      const providerName = targetPhone.startsWith('077') || targetPhone.startsWith('078') ? 'MTN' : 'AIRTEL';
      
      // Create a MobileMoneyJob for disbursement (withdrawal)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: targetPhone,
          amount: ugxToDisburse,  // Schema uses 'amount', not 'amountUGX'
          type: "DISBURSE",
          provider: providerName,
          status: "PENDING"
        }
      });
      // Create a Transaction entry for this redeem operation
      const txn = await prisma.transaction.create({
        data: {
          userId: userId,
          type: "REDEEM",
          amountUGX: ugxToDisburse,
          ugdxAmount: amountUGDX,
          toPhone: targetPhone,
          status: "PENDING",
          mmJobId: mmJob.id
        }
      });
      // For secure mobile money redemptions, handle burns based on user role
      // USER: Backend handles burn automatically via relayer
      // ADVANCED: Users handle their own on-chain burns
      
      if (req.user.role === 'USER') {
        // Normal users: Backend handles burn automatically via relayer
        logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔄 AUTO BURN: Processing automatic burn for user ${user.email}`);
        
        try {
          // First, check user's on-chain UGDX balance
          const userBalance = await ugdxContract.balanceOf(user.walletAddress);
          const userBalanceFormatted = ethers.formatUnits(userBalance, 18);
          
          logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔍 BALANCE CHECK: User ${user.email} has ${userBalanceFormatted} UGDX on-chain`);
          
          if (parseFloat(userBalanceFormatted) < amountUGDX) {
            logger.error(`[${new Date().toISOString().slice(11, 23)}] ❌ INSUFFICIENT BALANCE: User has ${userBalanceFormatted} UGDX but trying to burn ${amountUGDX}`);
            return res.status(400).json({ 
              error: "Insufficient on-chain UGDX balance",
              message: `You have ${userBalanceFormatted} UGDX on-chain but need ${amountUGDX} for withdrawal.`,
              balance: userBalanceFormatted,
              required: amountUGDX
            });
          }
          
          // Method 1: Try direct burn (if relayer has permission)
          logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔥 ATTEMPTING BURN: ${amountUGDX} UGDX from ${user.walletAddress}`);
          
          // Use burnFrom to burn user's tokens (relayer needs allowance or special permission)
          const burnAmount = ethers.parseUnits(amountUGDX.toString(), 18);
          const burnTx = await ugdxContract.connect(relayer).burnFrom(
            user.walletAddress,
            burnAmount
          );
          const receipt = await burnTx.wait();
          
          logger.info(`[${new Date().toISOString().slice(11, 23)}] ✅ AUTO BURN SUCCESS: Burned ${amountUGDX} UGDX from ${user.walletAddress} (${receipt.transactionHash})`);
          
          // Update transaction with burn hash
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { 
              txHash: receipt.transactionHash,
              status: "COMPLETED"
            }
          });
          
        } catch (err) {
          logger.error(`[${new Date().toISOString().slice(11, 23)}] ❌ AUTO BURN FAILED:`, {
            error: err.message,
            code: err.code,
            reason: err.reason,
            userWallet: user.walletAddress,
            burnAmount: amountUGDX
          });
          
          return res.status(500).json({ 
            error: "Failed to process token burn",
            message: "Unable to burn UGDX tokens for withdrawal. This may be due to insufficient allowance or balance.",
            details: err.reason || err.message
          });
        }
        
      } else if (req.user.role === 'ADVANCED') {
        // Advanced users: Expected to burn tokens themselves on-chain
        logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔧 ADVANCED USER: ${user.email} expected to handle burn independently`);
        
        // Just update the transaction status - advanced users handle burns themselves
        await prisma.transaction.update({
          where: { id: txn.id },
          data: { status: "PENDING_BURN" }
        });
        
      }
      
      // Deduct from ugdxCredit balance (for tracking purposes)
      await prisma.user.update({
        where: { id: userId },
        data: {
          ugdxCredit: {
            decrement: amountUGDX
          }
        }
      });
      
      // Initiate the mobile money payout via provider API
      await mmService.requestWithdrawal({
        amount: ugxToDisburse,
        phone: targetPhone,
        trans_id: mmJob.id   // reference our MobileMoneyJob ID for callback tracking
      });
      
      // Respond to client with the expected UGX disbursement and transaction reference
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