// src/controllers/p2p.js
const { prisma, logger, ugdxContract, bridgeContract, forwarderContract, relayer, provider, P2P_FEE_BPS, P2P_BATCH_MAX, P2P_MIN_TX_UGDX, P2P_MAX_TX_UGDX } = require('../config');
const ethers = require('ethers');
const { 
  createAndSignP2POnChainMetaTx,
  createP2POnChainMetaTx,
  createP2PBatchOnChainMetaTx,
  createP2PToMMMetaTx,
  executeMetaTx,
  getForwarderDomain,
  getMetaTxTypes,
  verifyMetaTxSignature,
  getContractAddress
} = require('../utils/metaTx');
const { decryptPrivateKey } = require('../utils/encryption');
const { deductGasCredit } = require('../utils/gas');

// using shared gas credit util from ../utils/gas

// POST /p2p/quote-batch - Estimate fees for a batch on-chain P2P
const quoteBatch = async (req, res, next) => {
  try {
    const { recipients = [], amountsUGDX = [], memos = [], payGasInTokens = true } = req.body || {};

    if (!Array.isArray(recipients) || !Array.isArray(amountsUGDX)) {
      return res.status(400).json({ error: 'recipients and amountsUGDX must be arrays' });
    }
    if (recipients.length === 0) return res.status(400).json({ error: 'At least one recipient required' });
    if (recipients.length !== amountsUGDX.length) return res.status(400).json({ error: 'recipients and amountsUGDX must be same length' });
    if (memos.length && memos.length !== recipients.length) return res.status(400).json({ error: 'memos length must match recipients when provided' });
    if (recipients.length > P2P_BATCH_MAX) return res.status(400).json({ error: `Max batch size is ${P2P_BATCH_MAX}` });

    // Per-item amount validation using env-backed limits
    for (let i = 0; i < amountsUGDX.length; i++) {
      const v = Number(amountsUGDX[i]);
      if (!Number.isFinite(v)) {
        return res.status(400).json({ error: `Invalid amount at index ${i}` });
      }
      if (v < P2P_MIN_TX_UGDX || v > P2P_MAX_TX_UGDX) {
        return res.status(400).json({ error: `Amount out of bounds at index ${i}. Must be between ${P2P_MIN_TX_UGDX} and ${P2P_MAX_TX_UGDX} UGDX` });
      }
    }

    const memosFilled = memos.length ? memos : new Array(recipients.length).fill('');

    // Convert to wei and compute protocol fees
    const amountsWei = amountsUGDX.map(a => ethers.parseEther(Number(a).toString()));
    const protocolFeesUGDX = amountsUGDX.map(a => (Number(a) * P2P_FEE_BPS) / 10000);
    const protocolFeeTotal = protocolFeesUGDX.reduce((s, v) => s + v, 0);
    const sumAmounts = amountsUGDX.reduce((s, v) => s + Number(v), 0);

    // Estimate gas
    let gasEstimate = 0n;
    try {
      gasEstimate = await ugdxContract.estimateGas.batchSendP2POnChain(recipients, amountsWei, memosFilled, true);
    } catch (e) {
      logger.warn('Gas estimate failed for batchSendP2POnChain, using fallback', { error: e?.message });
      gasEstimate = 500000n + BigInt(120000 * recipients.length); // heuristic fallback
    }
    const gasPrice = await provider.getGasPrice();
    const gasCostWei = gasEstimate * BigInt(gasPrice);
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    const gasInTokensUGDX = payGasInTokens ? gasCostEth * 3700 : 0; // UGDX ~ UGX, using fixed 3700 UGX/ETH

    const perItem = recipients.map((to, i) => ({
      to,
      amountUGDX: Number(amountsUGDX[i]),
      memo: memosFilled[i] || '',
      feeUGDX: protocolFeesUGDX[i],
      netToRecipientUGDX: Number(amountsUGDX[i]) - protocolFeesUGDX[i]
    }));

    const totalDebitUGDX = sumAmounts + protocolFeeTotal + gasInTokensUGDX;

    return res.json({
      summary: {
        items: recipients.length,
        amountTotalUGDX: sumAmounts,
        protocolFeeBps: P2P_FEE_BPS,
        protocolFeeTotalUGDX: protocolFeeTotal,
        gasInTokensUGDX,
        totalDebitUGDX
      },
      perItem,
      limits: { maxBatch: P2P_BATCH_MAX, minPerTxUGDX: P2P_MIN_TX_UGDX, maxPerTxUGDX: P2P_MAX_TX_UGDX }
    });
  } catch (err) {
    next(err);
  }
};

// POST /p2p/send-onchain-batch - Execute batch on-chain P2P via meta-tx
const sendOnChainBatch = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { recipients = [], amountsUGDX = [], memos = [], signature } = req.body || {};

    if (!Array.isArray(recipients) || !Array.isArray(amountsUGDX)) {
      return res.status(400).json({ error: 'recipients and amountsUGDX must be arrays' });
    }
    if (recipients.length === 0) return res.status(400).json({ error: 'At least one recipient required' });
    if (recipients.length !== amountsUGDX.length) return res.status(400).json({ error: 'recipients and amountsUGDX must be same length' });
    if (memos.length && memos.length !== recipients.length) return res.status(400).json({ error: 'memos length must match recipients when provided' });
    if (recipients.length > 8) return res.status(400).json({ error: 'Max batch size is 8' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const memosFilled = memos.length ? memos : new Array(recipients.length).fill('');
    const amountsWei = amountsUGDX.map(a => ethers.parseEther(Number(a).toString()));

    // Backend signing path using stored key
    if (!signature) {
      if (!user.sensei) {
        return res.status(400).json({ error: 'Signature required or enable backend signing (no private key stored)' });
      }

      try {
        const privateKey = decryptPrivateKey(user.sensei);
        const userWallet = new ethers.Wallet(privateKey, provider);
        const chainId = await provider.getNetwork().then(n => Number(n.chainId));

        const metaTxRequest = await createP2PBatchOnChainMetaTx(
          userWallet.address,
          recipients,
          amountsWei,
          memosFilled,
          true,
          ugdxContract,
          forwarderContract,
          chainId
        );

        const domain = getForwarderDomain(chainId, getContractAddress(forwarderContract));
        const types = getMetaTxTypes();
        const backendSignature = await userWallet.signTypedData(domain, types, metaTxRequest);

        const txResult = await executeMetaTx(forwarderContract, metaTxRequest, backendSignature);
        if (!txResult.success) {
          return res.status(400).json({ error: 'Meta-transaction execution failed', details: txResult.error });
        }

        // Record gas credit usage
        if (txResult.receipt) {
          await deductGasCredit({ user, receipt: txResult.receipt, note: 'p2p onchain batch meta-tx (backend-signed)' });
        }

        // Create P2PTransaction records per item
        const created = [];
        for (let i = 0; i < recipients.length; i++) {
          const rec = await prisma.p2PTransaction.create({
            data: {
              senderId: userId,
              senderAddress: userWallet.address,
              recipientAddress: recipients[i],
              amount: parseFloat(amountsUGDX[i]),
              netAmount: parseFloat(amountsUGDX[i]), // fee accounted via events
              transferType: 'onchain',
              memo: memosFilled[i] || '',
              txHash: txResult.txHash,
              status: 'COMPLETED',
              metaTxRequest: JSON.stringify(metaTxRequest),
              signature: backendSignature,
              gasInTokens: true
            }
          });
          created.push(rec.id);
        }

        return res.json({
          message: 'Batch P2P on-chain transfer completed',
          transactionHash: txResult.txHash,
          count: recipients.length,
          p2pTransactionIds: created
        });
      } catch (e) {
        logger.error('Batch backend-signing failed', e);
        return res.status(500).json({ error: 'Batch signing/execution failed', details: e?.message });
      }
    }

    // If signature supplied, we would verify and execute (two-phase). Not implemented yet.
    return res.status(400).json({ error: 'Client-signed batch meta-tx not implemented yet' });
  } catch (err) {
    next(err);
  }
};

// POST /transactions/send-onchain - Send UGDX to another wallet address
const sendOnChain = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    // Signature is no longer required from the frontend
    const { recipientAddress, amount, memo = '', signature } = req.body;

    // Validation
    if (!recipientAddress || !amount) {
      return res.status(400).json({ 
        error: "Recipient address and amount are required" 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ 
        error: "Amount must be greater than 0" 
      });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: userId } 
    });
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Meta-transaction flow
    if (!signature) {
      // Attempt backend signing with decrypted private key if stored
      if (user.sensei) {
        try {
          logger.info(`🔑 Backend signing P2P ON-CHAIN for ${user.email}`);

          const privateKey = decryptPrivateKey(user.sensei);
          const userWallet = new ethers.Wallet(privateKey, provider);

          const chainId = await provider.getNetwork().then(n => Number(n.chainId));

          const metaTxRequest = await createP2POnChainMetaTx(
            userWallet.address,
            recipientAddress,
            ethers.parseEther(amount.toString()),
            memo,
            true, // payGasInTokens
            ugdxContract,
            forwarderContract,
            chainId
          );

          const domain = getForwarderDomain(chainId, getContractAddress(forwarderContract));
          const types = getMetaTxTypes();

          const backendSignature = await userWallet.signTypedData(domain, types, metaTxRequest);
          logger.info(`✅ Backend signature created, executing meta-tx...`);

          const txResult = await executeMetaTx(forwarderContract, metaTxRequest, backendSignature);

          if (!txResult.success) {
            return res.status(400).json({
              error: "Meta-transaction execution failed",
              details: txResult.error
            });
          }

          const p2pTx = await prisma.p2PTransaction.create({
            data: {
              senderId: userId,
              senderAddress: userWallet.address,
              recipientAddress,
              amount: parseFloat(amount),
              netAmount: parseFloat(amount), // fees handled elsewhere
              transferType: 'onchain',
              txHash: txResult.txHash,
              status: 'COMPLETED',
              metaTxRequest: JSON.stringify(metaTxRequest),
              signature: backendSignature,
              gasInTokens: true
            }
          });

          logger.info(`✅ P2P ON-CHAIN: Backend-signed tx completed - ${txResult.txHash}`);

          // Record relayer native gas usage to GasDrip
          if (txResult.receipt) {
            await deductGasCredit({ user, receipt: txResult.receipt, note: 'p2p onchain meta-tx (backend-signed)' });
          }

          return res.json({
            message: "P2P transfer completed successfully",
            transactionHash: txResult.txHash,
            p2pTransactionId: p2pTx.id
          });
        } catch (backendError) {
          logger.error(`❌ Backend signing failed:`, backendError);
          return res.status(500).json({
            error: "Backend signing failed",
            details: backendError.message
          });
        }
      }
      // Phase 1: Create meta-transaction request for user to sign
      logger.info(`🔄 P2P ON-CHAIN: Creating meta-tx request for user ${user.email}`);
      
      try {
        const metaTxRequest = await createP2POnChainMetaTx(
          user.walletAddress || user.id,
          recipientAddress,
          ethers.parseEther(amount.toString()),
          memo,
          true, // payGasInTokens
          ugdxContract,
          forwarderContract,
          await provider.getNetwork().then(n => Number(n.chainId))
        );
        
        const domain = getForwarderDomain(
          await provider.getNetwork().then(n => Number(n.chainId)),
          getContractAddress(forwarderContract)
        );
        const types = getMetaTxTypes();
        
        logger.info(`✅ Meta-tx request created for user signing`);
        
        // Convert BigInt values to strings for JSON serialization
        const serializedMetaTxRequest = {
          ...metaTxRequest,
          value: metaTxRequest.value.toString(),
          gas: metaTxRequest.gas.toString(),
          nonce: metaTxRequest.nonce.toString(),
          validUntil: metaTxRequest.validUntil.toString()
        };
        
        return res.json({
          message: "Meta-transaction request created. Please sign and submit.",
          metaTxRequest: serializedMetaTxRequest,
          domain,
          types,
          instructions: "Sign this request with your wallet using EIP-712, then call this endpoint again with the signature."
        });
      } catch (creationError) {
        logger.error(`❌ Meta-tx creation failed:`, creationError);
        return res.status(500).json({ 
          error: "Meta-transaction creation failed", 
          details: creationError.message 
        });
      }
    } else {
      // Phase 2: Execute with user's signature
      logger.info(`✍️ P2P ON-CHAIN: Executing user-signed meta-tx for ${user.email}`);
      
      // Recreate the meta-transaction request (same parameters)
      const metaTxRequest = await createP2POnChainMetaTx(
        user.walletAddress || user.id,
        recipientAddress,
        ethers.parseEther(amount.toString()),
        memo,
        true, // payGasInTokens
        ugdxContract,
        forwarderContract,
        await provider.getNetwork().then(n => Number(n.chainId))
      );
      
      // Verify the signature matches the user
      const domain = getForwarderDomain(
        await provider.getNetwork().then(n => Number(n.chainId)),
        getContractAddress(forwarderContract)
      );
      const types = getMetaTxTypes();
      
      const isValidSignature = verifyMetaTxSignature(
        metaTxRequest,
        signature,
        await provider.getNetwork().then(n => Number(n.chainId)),
        getContractAddress(forwarderContract)
      );
      
      if (!isValidSignature) {
        return res.status(400).json({
          error: "Invalid signature",
          details: "Signature does not match the meta-transaction request"
        });
      }
      
      logger.info(`✅ Signature verified for user ${user.email}`);
      
      // Execute the meta-transaction
      const txResult = await executeMetaTx(forwarderContract, metaTxRequest, signature);

      if (!txResult.success) {
        return res.status(400).json({
          error: "Meta-transaction execution failed",
          details: txResult.error
        });
      }

      // Record P2P transaction in database
      const p2pTx = await prisma.p2PTransaction.create({
        data: {
          senderId: userId,
          senderAddress: user.walletAddress || user.id,
          recipientAddress,
          amount: parseFloat(amount),
          netAmount: parseFloat(amount), // Will be updated with actual net after fees
          transferType: 'onchain',
          txHash: txResult.txHash,
          status: 'COMPLETED',
          metaTxRequest: JSON.stringify(metaTxRequest),
          signature,
          gasInTokens: true
        }
      });


      logger.info(`✅ P2P ON-CHAIN: Transaction completed - ${txResult.txHash}`);

      // Record relayer native gas usage to GasDrip
      if (txResult.receipt) {
        await deductGasCredit({ user, receipt: txResult.receipt, note: 'p2p onchain meta-tx' });
      }

      return res.json({
        message: "P2P transfer completed successfully",
        transactionHash: txResult.txHash,
        p2pTransactionId: p2pTx.id
      });
    }
  } catch (error) {
    logger.error(`❌ P2P ON-CHAIN Error:`, error);
    next(error);
  }
};

// POST /transactions/send-to-mobile - Send UGDX to mobile money
const sendToMobile = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { recipientPhone, amount, signature } = req.body;

    // Validation
    if (!recipientPhone || !amount) {
      return res.status(400).json({ 
        error: "Recipient phone and amount are required" 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ 
        error: "Amount must be greater than 0" 
      });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: userId } 
    });
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Two-phase meta-transaction flow
    if (!signature) {
      // Phase 1: Create meta-transaction request
      logger.info(`🔄 P2P TO-MM: Creating meta-tx request for user ${user.email}`);
      
      const metaTxRequest = await createP2PToMMMetaTx(
        user.walletAddress || user.id,
        recipientPhone,
        ethers.parseEther(amount.toString()), // Convert to wei for ethers v6
        '', // memo
        true, // payGasInTokens
        ugdxContract,
        forwarderContract,
        await provider.getNetwork().then(n => Number(n.chainId))
      );

      return res.json({
        message: "Please sign this meta-transaction",
        metaTxRequest,
        requiresSignature: true
      });
    } else {
      // Phase 2: Execute signed meta-transaction
      logger.info(`⚡ P2P TO-MM: Executing signed meta-tx for user ${user.email}`);
      
      const metaTxRequest = await createP2PToMMMetaTx(
        user.walletAddress || user.id,
        recipientPhone,
        ethers.parseEther(amount.toString()), // Convert to wei for ethers v6
        '', // memo
        true, // payGasInTokens
        ugdxContract,
        forwarderContract,
        await provider.getNetwork().then(n => Number(n.chainId))
      );

      const txResult = await executeMetaTx(forwarderContract, metaTxRequest, signature);
      
      if (!txResult.success) {
        return res.status(400).json({ 
          error: "Transaction failed", 
          details: txResult.error 
        });
      }

      // Create mobile money job for the recipient
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId, // sender initiates the job
          phone: recipientPhone,
          amount: parseFloat(amount),
          type: 'DISBURSE', // sending money to recipient
          provider: 'SCRIPTNETWORKS',
          status: 'PENDING'
        }
      });

      // Record relayer native gas usage to GasDrip
      if (txResult.receipt) {
        await deductGasCredit({ user, receipt: txResult.receipt, note: 'p2p to-mobile meta-tx' });
      }

      // Record P2P transaction
      const p2pTx = await prisma.p2PTransaction.create({
        data: {
          senderId: userId,
          senderAddress: user.walletAddress || user.id,
          recipientPhone,
          amount: parseFloat(amount),
          netAmount: parseFloat(amount), // Will be updated with actual net after fees
          transferType: 'mobile_money',
          txHash: txResult.txHash,
          status: 'PENDING', // Will be updated when MM job completes
          mmJobId: mmJob.id,
          metaTxRequest: JSON.stringify(metaTxRequest),
          signature,
          gasInTokens: true
        }
      });

      logger.info(`✅ P2P TO-MM: Transaction initiated - ${txResult.txHash}, MM Job: ${mmJob.id}`);

      return res.json({
        message: "P2P to mobile money transfer initiated",
        transactionHash: txResult.txHash,
        p2pTransactionId: p2pTx.id,
        mobileMoneyJobId: mmJob.id,
        status: "Mobile money disbursement pending"
      });
    }

  } catch (error) {
    logger.error(`❌ P2P TO-MM Error:`, error);
    next(error);
  }
};

// GET /transactions/p2p/history - Get user's P2P transaction history
const getHistory = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const transactions = await prisma.p2PTransaction.findMany({
      where: { senderId: userId },
      include: {
        mmJob: true // Include mobile money job details if applicable
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    });

    const total = await prisma.p2PTransaction.count({
      where: { senderId: userId }
    });

    return res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    logger.error(`❌ P2P History Error:`, error);
    next(error);
  }
};

// GET /transactions/p2p/analytics - Get P2P analytics (admin only)
const getAnalytics = async (req, res, next) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'HYPERADMIN') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { startDate, endDate } = req.query;
    
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      };
    }

    // Get transaction counts and volumes
    const onChainStats = await prisma.p2PTransaction.aggregate({
      where: { 
        transferType: 'onchain',
        ...dateFilter
      },
      _count: { id: true },
      _sum: { amount: true }
    });

    const toMobileStats = await prisma.p2PTransaction.aggregate({
      where: { 
        transferType: 'mobile_money',
        ...dateFilter
      },
      _count: { id: true },
      _sum: { amount: true }
    });

    // Get unique senders
    const uniqueSenders = await prisma.p2PTransaction.groupBy({
      by: ['senderId'],
      where: dateFilter,
      _count: { senderId: true }
    });

    return res.json({
      summary: {
        onChain: {
          count: onChainStats._count.id || 0,
          volume: onChainStats._sum.amount || 0
        },
        toMobile: {
          count: toMobileStats._count.id || 0,
          volume: toMobileStats._sum.amount || 0
        },
        uniqueSenders: uniqueSenders.length
      },
      period: { startDate, endDate }
    });

  } catch (error) {
    logger.error(`❌ P2P Analytics Error:`, error);
    next(error);
  }
};

module.exports = {
  sendOnChain,
  sendToMobile,
  getHistory,
  getAnalytics,
  quoteBatch,
  sendOnChainBatch
};
