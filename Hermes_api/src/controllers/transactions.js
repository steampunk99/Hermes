const { prisma, logger, ugdxContract, bridgeContract, forwarderContract, relayer, provider, PROVIDER_FEE_BPS } = require('../config');
const ethers = require('ethers');
const mmService = require('../services/mmService');
const mmCfg = require('../config/mmConfig');
const {
  verifyMetaTxSignature,
  executeMetaTx,
  createBridgeBurnMetaTx,
  createUGDXTransferMetaTx,
  getForwarderDomain
} = require('../utils/metaTx');
const { deductGasCredit } = require('../utils/gas');


// using shared gas credit util from ../utils/gas

class TransactionController {

// GET /transactions/quote-deposit - preview provider fee for deposit (mint)
  async quoteDeposit(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amount, phone } = req.query;
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Amount must be a positive number' });
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const targetPhone = phone || user.phone;
      if (!targetPhone) return res.status(400).json({ error: 'Phone is required' });

      const operator = mmCfg.getOperator(targetPhone);
      const provider = operator ? 'SCRIPTNETWORKS' : 'UNKNOWN';
      const feeInfo = mmCfg.calcProviderFee({ operator, table: 'sending', amount: amt });
      const fee = feeInfo.fee || 0;
      const grossCharge = amt + fee; // cash charged to user by provider
      const ugdxToMint = amt; // minting is free on-chain; 1:1

      return res.json({
        route: 'deposit',
        operator,
        provider,
        currency: feeInfo.currency,
        amountUGX: amt,
        ugdxToMint,
        totalFeeUGX: fee,
        grossChargeUGX: grossCharge,
        breakdown: { providerFeeUGX: fee, protocolFeeUGDX: 0, gasInTokensUGDX: 0 },
        tier: feeInfo.tier
      });
    } catch (err) { next(err); }
  }

// GET /transactions/quote-withdraw - preview provider fee for withdraw (redeem)
  async quoteWithdraw(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amount, phone, mode = 'DEDUCT' } = req.query; // amount in UGX recipient target
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Amount must be a positive number' });
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const targetPhone = phone || user.phone;
      if (!targetPhone) return res.status(400).json({ error: 'Phone is required' });

      const operator = mmCfg.getOperator(targetPhone);
      const provider = operator ? 'SCRIPTNETWORKS' : 'UNKNOWN';
      const feeInfo = mmCfg.calcProviderFee({ operator, table: 'withdraw', amount: amt });
      const providerFee = feeInfo.fee || 0; // UGX

      let burnUGDX; // how many tokens user must burn
      let recipientUGX; // what recipient receives
      let mmJobAmountUGX; // what we instruct provider to pay out

      if (String(mode).toUpperCase() === 'ON_TOP') {
        // Recipient receives amt; user burns amt + fee in UGDX terms
        recipientUGX = amt;
        burnUGDX = amt + providerFee; // 1 UGDX == 1 UGX assumption
        mmJobAmountUGX = recipientUGX; // provider pays exactly target amount; fee paid by user on top
      } else {
        // DEDUCT: Recipient gets amt - fee; user burns amt
        recipientUGX = Math.max(amt - providerFee, 0);
        burnUGDX = amt;
        mmJobAmountUGX = recipientUGX; // provider disburses net
      }

      // Gas for withdraw path is paid by relayer natively today (not tokenized)
      return res.json({
        route: 'withdraw',
        operator,
        provider,
        currency: feeInfo.currency,
        requestedAmountUGX: amt,
        mode: String(mode).toUpperCase(),
        providerFeeUGX: providerFee,
        recipientUGX,
        burnUGDX,
        breakdown: { providerFeeUGX: providerFee, protocolFeeUGDX: 0, gasInTokensUGDX: 0 }
      });
    } catch (err) { next(err); }
  }

// POST /transactions/mint - user deposits UGX to mint UGDX
  async mintUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amount, phone } = req.body;  // amount in UGX and optional phone override
      
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Deposit amount must be greater than 0." });
      }
      // Ensure user exists and has a wallet address to receive UGDX
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.walletAddress) {
        return res.status(400).json({ error: "No wallet address linked. Please add a crypto wallet address to receive UGDX." });
      }

      const targetPhone = phone || user.phone;
      if (!targetPhone) {
        return res.status(400).json({ error: "A phone number is required to initiate a deposit." });
      }

      logger.info(`☯️ Creating mobile money job for user: ${user.email} (ID: ${user.id}, Wallet: ${user.walletAddress}, Phone: ${targetPhone})`);
      // Minting onramp is free on-chain; provider fee is cash-side only (computed in quotes)
      const ugdxToMint = amount;  // assuming 1 UGX = 1 UGDX
      // Provider is Scriptnetworks (handles MTN & Airtel under the hood)
      const providerName = 'SCRIPTNETWORKS';
      
      // Create a MobileMoneyJob entry for collection (deposit)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: targetPhone,
          amount: amount,  // cash amount to collect; provider fee handled off-chain
          type: "DEPOSIT",
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

      // Initiate deposit with provider (Scriptnetworks) -> should return PENDING immediately
      let providerResp;
      try {
        providerResp = await mmService.requestToPay({
          amount: amount,
          phone: targetPhone,
          trans_id: mmJob.id
        });
        logger.info(`Scriptnetworks deposit initiated (Job #${mmJob.id})`, { providerResp });
      } catch (e) {
        logger.error('Failed to initiate Scriptnetworks deposit, falling back to manual confirmation', { error: e.message, jobId: mmJob.id });
      }

      // Respond to client with PENDING status; provider will callback SUCCESSFUL on completion
      return res.status(200).json({
        message: "Deposit initiated. Confirm on your phone. We will mint after provider confirms payment.",
        jobId: mmJob.id,
        netUGDX: ugdxToMint,
        // feeUGX is not included here; use /transactions/quote-deposit for provider fee preview
        transactionId: txn.id,
        status: "PENDING",
        provider: providerName,
        providerResponse: providerResp || null
      });
    } catch (err) {
      next(err);
    }
  };

// POST /transactions/redeem - user withdraws UGX by burning UGDX (ON_TOP fee mode)
  async redeemUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amountUGDX, phone } = req.body; // amountUGDX here is the requested UGX payout target
      if (!amountUGDX || amountUGDX <= 0) {
        return res.status(400).json({ error: "Withdrawal amount must be greater than 0." });
      }
      // Determine target phone: use provided phone or default to user's phone
      const targetPhone = phone || (await prisma.user.findUnique({ where: { id: userId } }))?.phone;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      
      // Compute provider fee using mmfees.json (withdraw table) for ON_TOP mode
      const operator = mmCfg.getOperator(targetPhone);
      const feeInfo = mmCfg.calcProviderFee({ operator, table: 'withdraw', amount: Number(amountUGDX) });
      const providerFee = feeInfo.fee || 0; // UGX

      // ON_TOP mode: recipient gets full requested amount; user burns amount + providerFee
      const burnAmountUGDX = Number(amountUGDX) + providerFee;

      // Check off-chain UGDX credit balance (user must have enough to cover burn)
      const ugdxCreditBalance = user.ugdxCredit || 0;
      if (ugdxCreditBalance < burnAmountUGDX) {
        return res.status(400).json({ 
          error: "Insufficient UGDX credit balance to cover amount plus fee.",
          availableBalance: ugdxCreditBalance,
          requestedAmount: Number(amountUGDX),
          providerFee,
          requiredBurn: burnAmountUGDX
        });
      }

      const ugxToDisburse = Number(amountUGDX); // provider pays full requested amount
      // Use Scriptnetworks as unified provider wrapper
      const providerName = 'SCRIPTNETWORKS';
      
      // Create a MobileMoneyJob for disbursement (withdrawal)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: targetPhone,
          amount: ugxToDisburse,  // provider disburses full amount in ON_TOP mode
          type: "WITHDRAW",
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
          ugdxAmount: burnAmountUGDX,
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
          
          if (parseFloat(userBalanceFormatted) < burnAmountUGDX) {
            logger.error(`[${new Date().toISOString().slice(11, 23)}] ❌ INSUFFICIENT BALANCE: User has ${userBalanceFormatted} UGDX but trying to burn ${burnAmountUGDX}`);
            return res.status(400).json({ 
              error: "Insufficient on-chain UGDX balance",
              message: `You have ${userBalanceFormatted} UGDX on-chain but need ${burnAmountUGDX} for withdrawal (amount + fee).`,
              balance: userBalanceFormatted,
              required: burnAmountUGDX
            });
          }
          
          // Method 1: Try direct burn (if relayer has permission)
          logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔥 ATTEMPTING BURN: ${burnAmountUGDX} UGDX from ${user.walletAddress}`);
          
          // Use burnFrom to burn user's tokens (relayer needs allowance or special permission)
          const burnAmount = ethers.parseUnits(burnAmountUGDX.toString(), 18);
          const burnTx = await ugdxContract.connect(relayer).burnFrom(
            user.walletAddress,
            burnAmount
          );
          const receipt = await burnTx.wait();
          
          logger.info(`[${new Date().toISOString().slice(11, 23)}] ✅ AUTO BURN SUCCESS: Burned ${burnAmountUGDX} UGDX from ${user.walletAddress} (${receipt.transactionHash})`);
          
          // Record relayer gas spend to GasDrip (v6-safe), and decrement user's gasCredit
          await deductGasCredit({ user, tx: burnTx, receipt, note: 'redeemUGDX burn' });

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
      
      // Deduct from ugdxCredit balance (for tracking purposes) — burn amount in ON_TOP mode
      await prisma.user.update({
        where: { id: userId },
        data: {
          ugdxCredit: {
            decrement: burnAmountUGDX
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
        recipientUGX: ugxToDisburse,
        providerFeeUGX: providerFee,
        burnUGDX: burnAmountUGDX,
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

}

module.exports = new TransactionController();