// File: src/services/eventProcessor.js
// Hybrid Event Processing System: WebSocket + Block Scanning + Replay
const { ethers } = require('ethers');
const { prisma, logger, wsProvider, provider, bridgeContract, oracleContract } = require('../config');

class HybridEventProcessor {
  constructor() {
    this.isProcessing = false;
    
    // Create contract instances with event ABIs for scanning
    const bridgeEventABI = [
      "event USDTSwappedForUGDX(address indexed user, uint256 usdtAmount, uint256 ugdxAmount, uint256 feeAmount, uint256 exchangeRate)",
      "event UGDXBurnedForWithdrawal(address indexed user, uint256 ugdxAmount, uint256 timestamp)",
      "event MobileMoneyMintUGDX(address indexed user, uint256 ugdxAmount, uint256 timestamp)"
    ];
    
    const oracleEventABI = [
      "event PriceUpdated(uint256 indexed oldRate, uint256 indexed newRate, uint256 timestamp, address indexed updater)"
    ];
    
    this.contracts = {
      bridge: {
        address: process.env.BRIDGE_CONTRACT_ADDRESS,
        name: 'Bridge',
        contract: new ethers.Contract(process.env.BRIDGE_CONTRACT_ADDRESS, bridgeEventABI, provider),
        events: {
          'USDTSwappedForUGDX': 'USDTSwappedForUGDX(address,uint256,uint256,uint256,uint256)',
          'UGDXBurnedForWithdrawal': 'UGDXBurnedForWithdrawal(address,uint256,uint256)',
          'MobileMoneyMintUGDX': 'MobileMoneyMintUGDX(address,uint256,uint256)'
        }
      },
      oracle: {
        address: process.env.ORACLE_CONTRACT_ADDRESS,
        name: 'Oracle', 
        contract: new ethers.Contract(process.env.ORACLE_CONTRACT_ADDRESS, oracleEventABI, provider),
        events: {
          'PriceUpdated': 'PriceUpdated(uint256,uint256,uint256,address)'
        }
      }
    };
  }

  /**
   * Initialize hybrid event processing system
   */
  async initialize() {
    try {
      logger.info('Initializing ☯️ events...');
      
      // Initialize processing state for each contract
      await this.initializeProcessingState();
      
      // Start WebSocket listeners for real-time events
      await this.startWebSocketListeners();
      
      // Start periodic block scanning for missed events
      this.startBlockScanner();
      
      // Replay missed events from startup
      await this.replayMissedEvents();
      
      logger.info('☯️ events initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize ☯️ events:', error);
      throw error;
    }
  }

  /**
   * Initialize processing state for each contract
   */
  async initializeProcessingState() {
    for (const [key, contractInfo] of Object.entries(this.contracts)) {
      await prisma.eventProcessingState.upsert({
        where: { contractAddress: contractInfo.address },
        update: {},
        create: {
          contractAddress: contractInfo.address,
          contractName: contractInfo.name,
          lastProcessedBlock: 0
        }
      });
    }
  }

  /**
   * Start WebSocket listeners for real-time event processing
   */
  async startWebSocketListeners() {
    if (!wsProvider) {
      logger.warn('WebSocket provider not available, skipping real-time listeners');
      return;
    }

    logger.info('Starting WebSocket ☯️ listeners...');

    // Bridge events
    const bridgeWs = new ethers.Contract(
      this.contracts.bridge.address,
      [
        "event USDTSwappedForUGDX(address indexed user, uint256 usdtAmount, uint256 ugdxAmount, uint256 feeAmount, uint256 exchangeRate)",
        "event UGDXBurnedForWithdrawal(address indexed user, uint256 ugdxAmount, uint256 timestamp)"
      ],
      wsProvider
    );

    // Oracle events
    const oracleWs = new ethers.Contract(
      this.contracts.oracle.address,
      [
        "event PriceUpdated(uint256 indexed oldRate, uint256 indexed newRate, uint256 timestamp, address indexed updater)"
      ],
      wsProvider
    );

    // Bridge event listeners
    bridgeWs.on('USDTSwappedForUGDX', async (user, usdtAmount, ugdxAmount, feeAmount, exchangeRate, event) => {
      await this.processEvent('USDTSwappedForUGDX', {
        user, usdtAmount, ugdxAmount, feeAmount, exchangeRate
      }, event);
    });

    bridgeWs.on('UGDXBurnedForWithdrawal', async (user, ugdxAmount, timestamp, event) => {
      await this.processEvent('UGDXBurnedForWithdrawal', {
        user, ugdxAmount, timestamp
      }, event);
    });

    // Oracle event listeners
    oracleWs.on('PriceUpdated', async (oldRate, newRate, timestamp, updater, event) => {
      await this.processEvent('PriceUpdated', {
        oldRate, newRate, timestamp, updater
      }, event);
    });

    logger.info('WebSocket ☯️ listeners started successfully');
  }

  /**
   * Process individual events with idempotency and error handling
   */
  async processEvent(eventName, params, event) {
    try {
      const { transactionHash, blockNumber, logIndex, address } = event;
      
      // Handle missing transaction hash (can happen with WebSocket events)
      if (!transactionHash) {
        logger.warn(`Skipping ${eventName} event with missing transaction hash`);
        return;
      }
      
      logger.info(`Processing ${eventName} event from tx: ${transactionHash}`);

      // Check if event already processed (idempotency)
      const existingEvent = await prisma.processedEvent.findUnique({
        where: { txHash_logIndex: { txHash: transactionHash, logIndex: logIndex || 0 } }
      });

      if (existingEvent && existingEvent.processed) {
        logger.debug(`Event ${eventName} already processed, skipping`);
        return;
      }

      // Process event in transaction for atomicity
      await prisma.$transaction(async (tx) => {
        // Record event as being processed
        await tx.processedEvent.upsert({
          where: { txHash_logIndex: { txHash: transactionHash, logIndex: logIndex || 0 } },
          update: { processed: true, processedAt: new Date() },
          create: {
            txHash: transactionHash,
            eventName,
            blockNumber,
            logIndex: logIndex || 0,
            contractAddress: address,
            processed: true,
            processedAt: new Date()
          }
        });

        // Execute business logic based on event type
        await this.executeEventLogic(eventName, params, event, tx);

        // Update last processed block
        await this.updateLastProcessedBlock(address, blockNumber, tx);
      });

      logger.info(`Successfully processed ${eventName} event`);
    } catch (error) {
      logger.error(`Failed to process ${eventName} event:`, error);
      // Don't throw - let other events continue processing
    }
  }

  /**
   * Execute business logic for specific event types
   */
  async executeEventLogic(eventName, params, event, tx) {
    switch (eventName) {
      case 'USDTSwappedForUGDX':
        await this.handleUSDTSwappedForUGDX(params, event, tx);
        break;
      case 'MobileMoneyMintUGDX':
        await this.handleMobileMoneyMintUGDX(params, event, tx);
        break;
      case 'UGDXBurnedForWithdrawal':
        await this.handleUGDXBurnedForWithdrawal(params, event, tx);
        break;
      case 'PriceUpdated':
        await this.handlePriceUpdated(params, event, tx);
        break;
      default:
        logger.warn(`Unknown event type: ${eventName}`);
    }
  }

  /**
   * Handle USDT swapped for UGDX events
   */
  async handleUSDTSwappedForUGDX(params, event, tx) {
    const { user, usdtAmount, ugdxAmount } = params;
    const usdtValue = parseFloat(ethers.formatUnits(usdtAmount, 6));
    const ugdxValue = parseFloat(ethers.formatUnits(ugdxAmount, 18));

    // Find the corresponding user in the database
    const dbUser = await tx.user.findUnique({ where: { walletAddress: user } });
    if (!dbUser) {
      logger.warn(`Swap event for unknown user ${user}, skipping DB record.`);
      return;
    }

    // Record the swap as a completed MINT transaction
    await tx.transaction.create({
      data: {
        userId: dbUser.id,
        type: "MINT",
        amountUGX: ugdxValue,
        ugdxAmount: ugdxValue,
        txHash: event.transactionHash,
        status: "COMPLETED"
      }
    });

    // Update user's off-chain UGDX credit balance
    await tx.user.update({
      where: { id: dbUser.id },
      data: {
        ugdxCredit: {
          increment: ugdxValue
        }
      }
    });

    logger.info(`☯️ Recorded MINT transaction for user ${user}: ${ugdxValue} UGDX (off-chain balance updated)`);
  }

  /**
   * Handle Mobile Money UGDX mint events (admin confirmations)
   */
  async handleMobileMoneyMintUGDX(params, event, tx) {
    const { user, ugdxAmount, timestamp } = params;
    const ugdxValue = parseFloat(ethers.formatUnits(ugdxAmount, 18));

    // Find the corresponding user in the database
    const dbUser = await tx.user.findUnique({ where: { walletAddress: user } });
    if (!dbUser) {
      logger.warn(`Mobile money mint event for unknown user ${user}, skipping DB record.`);
      return;
    }

    // Record the mint as a completed MINT transaction
    await tx.transaction.create({
      data: {
        userId: dbUser.id,
        type: "MINT",
        amountUGX: ugdxValue, // For mobile money, UGX = UGDX (1:1)
        ugdxAmount: ugdxValue,
        txHash: event.transactionHash,
        status: "COMPLETED"
      }
    });

    // Update user's off-chain UGDX credit balance
    await tx.user.update({
      where: { id: dbUser.id },
      data: {
        ugdxCredit: {
          increment: ugdxValue
        }
      }
    });

    logger.info(`☯️ Recorded MOBILE MONEY MINT for user ${user}: ${ugdxValue} UGDX (off-chain balance updated)`);
  }

  /**
   * Handle UGDX burned for withdrawal events
   */
  async handleUGDXBurnedForWithdrawal(params, event, tx) {
    const { user, ugdxAmount } = params;
    const ugdxValue = parseFloat(ethers.formatUnits(ugdxAmount, 18));

    // Find user and pending withdrawal transactions
    const dbUser = await tx.user.findUnique({ where: { walletAddress: user } });
    if (!dbUser) {
      logger.error(`Burn event from unknown address ${user}, no action taken.`);
      return;
    }

    // Find pending transactions for this user
    const pendingTxs = await tx.transaction.findMany({
      where: {
        userId: dbUser.id,
        status: "PENDING",
        OR: [{ type: "REDEEM" }, { type: "SEND" }]
      },
      include: { mmJob: true }
    });

    if (pendingTxs.length > 0) {
      const matchingTx = pendingTxs[0];
      
      // Update transaction status
      await tx.transaction.update({
        where: { id: matchingTx.id },
        data: { 
          status: "COMPLETED",
          txHash: event.transactionHash
        }
      });

      // Trigger mobile money disbursement if applicable
      if (matchingTx.mmJob && matchingTx.type === "REDEEM") {
        const mmService = require('./mmService');
        await mmService.requestToPay({
          amount: matchingTx.mmJob.amount,
          phone: matchingTx.mmJob.phone,
          trans_id: matchingTx.mmJob.id.toString()
        });
      }

      logger.info(`Updated transaction ${matchingTx.id} to COMPLETED for burn event`);
    }
  }

  /**
   * Handle Oracle price updated events
   */
  async handlePriceUpdated(params, event, tx) {
    const { oldRate, newRate, timestamp } = params;
    const oldRateVal = parseFloat(ethers.formatUnits(oldRate, 18));
    const newRateVal = parseFloat(ethers.formatUnits(newRate, 18));
    const time = new Date(Number(timestamp) * 1000);

    logger.info(`Oracle price updated: ${oldRateVal} → ${newRateVal} UGX/USD at ${time.toISOString()}`);

    // Update local price cache
    await tx.oraclePrice.upsert({
      where: { id: 1 },
      update: { currentRate: newRateVal, lastUpdated: time },
      create: { id: 1, currentRate: newRateVal, lastUpdated: time }
    });
  }

  /**
   * Update last processed block for a contract
   */
  async updateLastProcessedBlock(contractAddress, blockNumber, tx) {
    await tx.eventProcessingState.update({
      where: { contractAddress },
      data: { lastProcessedBlock: Math.max(blockNumber, 0) }
    });
  }

  /**
   * Start periodic block scanning for missed events
   */
  startBlockScanner() {
    // Scan for missed events every 5 minutes
    setInterval(async () => {
      if (!this.isProcessing) {
        await this.scanForMissedEvents();
      }
    }, 5 * 60 * 1000); // 5 minutes

    logger.info('Block scanner started (5-minute intervals)');
  }

  /**
   * Scan for missed events across all contracts
   */
  async scanForMissedEvents() {
    try {
      this.isProcessing = true;
      const currentBlock = await provider.getBlockNumber();

      for (const [key, contractInfo] of Object.entries(this.contracts)) {
        const state = await prisma.eventProcessingState.findUnique({
          where: { contractAddress: contractInfo.address }
        });

        if (state && state.lastProcessedBlock < currentBlock - 1) {
          const fromBlock = state.lastProcessedBlock + 1;
          const toBlock = Math.min(currentBlock, fromBlock + 1000); // Process in chunks

          logger.info(`Scanning ${contractInfo.name} events from block ${fromBlock} to ${toBlock}`);
          await this.scanContractEvents(contractInfo, fromBlock, toBlock);
        }
      }
    } catch (error) {
      logger.error('Error during block scanning:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Scan events for a specific contract
   */
  async scanContractEvents(contractInfo, fromBlock, toBlock) {
    try {
      for (const [eventName, eventSignature] of Object.entries(contractInfo.events)) {
        logger.debug(`Scanning ${eventName} events from block ${fromBlock} to ${toBlock}`);
        
        // Use queryFilter method which is simpler and more reliable
        const filter = contractInfo.contract.filters[eventName]();
        const events = await contractInfo.contract.queryFilter(filter, fromBlock, toBlock);

        logger.debug(`Found ${events.length} ${eventName} events`);
        
        for (const event of events) {
          try {
            // Extract parameters from the event
            const params = this.extractEventParams(eventName, event.args);
            await this.processEvent(eventName, params, event);
          } catch (processError) {
            logger.warn(`Failed to process ${eventName} event:`, processError.message);
          }
        }
      }
    } catch (error) {
      logger.error(`Error scanning ${contractInfo.name} events:`, error);
    }
  }

  /**
   * Extract parameters from event args based on event type
   */
  extractEventParams(eventName, args) {
    switch (eventName) {
      case 'USDTSwappedForUGDX':
        return {
          user: args.user,
          usdtAmount: args.usdtAmount,
          ugdxAmount: args.ugdxAmount,
          feeAmount: args.feeAmount,
          exchangeRate: args.exchangeRate
        };
      case 'UGDXBurnedForWithdrawal':
        return {
          user: args.user,
          ugdxAmount: args.ugdxAmount,
          timestamp: args.timestamp
        };
      case 'PriceUpdated':
        return {
          oldRate: args.oldRate,
          newRate: args.newRate,
          timestamp: args.timestamp,
          updater: args.updater
        };
      default:
        return args;
    }
  }

  /**
   * Replay missed events from last processed block on startup
   */
  async replayMissedEvents() {
    try {
      logger.info('Checking for missed events on startup...');
      await this.scanForMissedEvents();
      logger.info('Startup event replay completed');
    } catch (error) {
      logger.error('Error during startup event replay:', error);
    }
  }
}

// Export singleton instance
const eventProcessor = new HybridEventProcessor();
module.exports = { eventProcessor };
