// src/services/p2pEventProcessor.js
const { prisma, logger, ugdxContract, bridgeContract } = require('../config');
const mmService = require('./mmService');

class P2PEventProcessor {
  
  // Process P2PTransferOnChain events from UGDX contract
  async processP2POnChainEvent(event) {
    try {
      const { from, to, amount, fee, timestamp } = event.args;
      const txHash = event.transactionHash;
      const blockNumber = event.blockNumber;

      logger.info(`🔄 Processing P2P ON-CHAIN event: ${txHash}`);

      // Check if event already processed
      const existingEvent = await prisma.processedEvent.findUnique({
        where: {
          txHash_logIndex: {
            txHash,
            logIndex: event.logIndex
          }
        }
      });

      if (existingEvent && existingEvent.processed) {
        logger.info(`⚠️ P2P ON-CHAIN event already processed: ${txHash}`);
        return;
      }

      // Find the P2P transaction in our database by txHash
      const p2pTx = await prisma.p2PTransaction.findFirst({
        where: { 
          txHash,
          transferType: 'onchain'
        }
      });

      if (p2pTx) {
        // Update transaction status to completed
        await prisma.p2PTransaction.update({
          where: { id: p2pTx.id },
          data: { 
            status: 'COMPLETED',
            fee: parseFloat(fee.toString()) / 1e18, // Convert from wei
            updatedAt: new Date()
          }
        });

        logger.info(`✅ P2P ON-CHAIN transaction updated: ${p2pTx.id}`);
      }

      // Update P2P analytics
      await this.updateP2PAnalytics('ON_CHAIN', amount, fee, timestamp);

      // Mark event as processed
      await prisma.processedEvent.upsert({
        where: {
          txHash_logIndex: {
            txHash,
            logIndex: event.logIndex
          }
        },
        update: {
          processed: true,
          processedAt: new Date()
        },
        create: {
          txHash,
          eventName: 'P2PTransferOnChain',
          blockNumber,
          logIndex: event.logIndex,
          contractAddress: event.address.toLowerCase(),
          processed: true,
          processedAt: new Date()
        }
      });

      logger.info(`✅ P2P ON-CHAIN event processed successfully: ${txHash}`);

    } catch (error) {
      logger.error(`❌ Error processing P2P ON-CHAIN event:`, error);
      throw error;
    }
  }

  // Process P2PTransferToMM events from UGDX contract
  async processP2PToMMEvent(event) {
    try {
      const { from, phone, amount, fee, timestamp } = event.args;
      const txHash = event.transactionHash;
      const blockNumber = event.blockNumber;

      logger.info(`🔄 Processing P2P TO-MM event: ${txHash}`);

      // Check if event already processed
      const existingEvent = await prisma.processedEvent.findUnique({
        where: {
          txHash_logIndex: {
            txHash,
            logIndex: event.logIndex
          }
        }
      });

      if (existingEvent && existingEvent.processed) {
        logger.info(`⚠️ P2P TO-MM event already processed: ${txHash}`);
        return;
      }

      // Find the P2P transaction in our database
      const p2pTx = await prisma.p2PTransaction.findFirst({
        where: { 
          txHash,
          transferType: 'mobile_money'
        },
        include: {
          mmJob: true
        }
      });

      if (p2pTx && p2pTx.mmJob) {
        // Update transaction with fee info
        await prisma.p2PTransaction.update({
          where: { id: p2pTx.id },
          data: { 
            fee: parseFloat(fee.toString()) / 1e18, // Convert from wei
            updatedAt: new Date()
          }
        });

        // Process mobile money disbursement using existing mmService pattern
        try {
          logger.info(`📱 Initiating mobile money disbursement for job: ${p2pTx.mmJob.id}`);
          
          // Use existing requestWithdrawal method like in transactions controller
          const mmResult = await mmService.requestWithdrawal({
            amount: p2pTx.mmJob.amount,
            phone: p2pTx.mmJob.phone,
            trans_id: p2pTx.mmJob.id.toString()
          });
          
          // Check if withdrawal was successful (align with existing webhook patterns)
          if (mmResult && mmResult.status === 'success') {
            // Update both P2P transaction and MM job status
            await prisma.p2PTransaction.update({
              where: { id: p2pTx.id },
              data: { status: 'COMPLETED' }
            });

            await prisma.mobileMoneyJob.update({
              where: { id: p2pTx.mmJob.id },
              data: { 
                status: 'SUCCESS',
                trans_id: mmResult.trans_id || mmResult.transaction_id
              }
            });

            logger.info(`✅ P2P TO-MM completed successfully: ${txHash}`);
          } else {
            // Mark as pending - will be updated by webhook
            logger.info(`⏳ P2P TO-MM withdrawal initiated, awaiting webhook confirmation: ${txHash}`);
          }
        } catch (mmError) {
          logger.error(`❌ Mobile money processing failed:`, mmError);
          
          // Mark as failed
          await prisma.p2PTransaction.update({
            where: { id: p2pTx.id },
            data: { status: 'FAILED' }
          });
          
          await prisma.mobileMoneyJob.update({
            where: { id: p2pTx.mmJob.id },
            data: { status: 'FAIL' }
          });
        }
      }

      // Update P2P analytics
      await this.updateP2PAnalytics('TO_MOBILE_MONEY', amount, fee, timestamp);

      // Mark event as processed
      await prisma.processedEvent.upsert({
        where: {
          txHash_logIndex: {
            txHash,
            logIndex: event.logIndex
          }
        },
        update: {
          processed: true,
          processedAt: new Date()
        },
        create: {
          txHash,
          eventName: 'P2PTransferToMM',
          blockNumber,
          logIndex: event.logIndex,
          contractAddress: event.address.toLowerCase(),
          processed: true,
          processedAt: new Date()
        }
      });

      logger.info(`✅ P2P TO-MM event processed successfully: ${txHash}`);

    } catch (error) {
      logger.error(`❌ Error processing P2P TO-MM event:`, error);
      throw error;
    }
  }

  // Update P2P analytics in database
  async updateP2PAnalytics(type, amount, fee, timestamp) {
    try {
      const date = new Date(timestamp * 1000); // Convert from Unix timestamp
      const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD format

      const amountInUGDX = parseFloat(amount.toString()) / 1e18; // Convert from wei
      const feeInUGDX = parseFloat(fee.toString()) / 1e18;

      // Update or create daily analytics record
      await prisma.p2PAnalytics.upsert({
        where: {
          date: new Date(dateKey)
        },
        update: {
          totalTransactions: { increment: 1 },
          totalVolume: { increment: amountInUGDX },
          totalFees: { increment: feeInUGDX },
          ...(type === 'onchain' ? {
            onChainTransactions: { increment: 1 },
            onChainVolume: { increment: amountInUGDX }
          } : {
            mmTransactions: { increment: 1 },
            mmVolume: { increment: amountInUGDX }
          }),
          updatedAt: new Date()
        },
        create: {
          date: new Date(dateKey),
          totalTransactions: 1,
          totalVolume: amountInUGDX,
          totalFees: feeInUGDX,
          onChainTransactions: type === 'onchain' ? 1 : 0,
          onChainVolume: type === 'onchain' ? amountInUGDX : 0,
          mmTransactions: type === 'mobile_money' ? 1 : 0,
          mmVolume: type === 'mobile_money' ? amountInUGDX : 0,
          uniqueSenders: 1
        }
      });

      logger.info(`📊 P2P Analytics updated for ${type} on ${dateKey}`);

    } catch (error) {
      logger.error(`❌ Error updating P2P analytics:`, error);
    }
  }

  // Initialize P2P event listeners
  initP2PEventListeners() {
    try {
      logger.info('🎧 Initializing P2P event listeners...');

      // Listen for P2P on-chain transfer events
      ugdxContract.on('P2PTransferOnChain', async (from, to, amount, fee, timestamp, event) => {
        try {
          await this.processP2POnChainEvent({
            args: { from, to, amount, fee, timestamp },
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            logIndex: event.logIndex,
            address: event.address
          });
        } catch (error) {
          logger.error('❌ Error in P2PTransferOnChain listener:', error);
        }
      });

      // Listen for P2P to mobile money events
      ugdxContract.on('P2PTransferToMM', async (from, phone, amount, fee, timestamp, event) => {
        try {
          await this.processP2PToMMEvent({
            args: { from, phone, amount, fee, timestamp },
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            logIndex: event.logIndex,
            address: event.address
          });
        } catch (error) {
          logger.error('❌ Error in P2PTransferToMM listener:', error);
        }
      });

      logger.info('✅ P2P event listeners initialized successfully');

    } catch (error) {
      logger.error('❌ Failed to initialize P2P event listeners:', error);
      throw error;
    }
  }

  // Scan for historical P2P events (for catching up on missed events)
  async scanHistoricalP2PEvents(fromBlock = 'earliest', toBlock = 'latest') {
    try {
      logger.info(`🔍 Scanning historical P2P events from block ${fromBlock} to ${toBlock}`);

      // Get P2P on-chain events
      const onChainEvents = await ugdxContract.queryFilter(
        ugdxContract.filters.P2PTransferOnChain(),
        fromBlock,
        toBlock
      );

      // Get P2P to mobile money events
      const toMMEvents = await ugdxContract.queryFilter(
        ugdxContract.filters.P2PTransferToMM(),
        fromBlock,
        toBlock
      );

      logger.info(`📊 Found ${onChainEvents.length} P2P on-chain events and ${toMMEvents.length} P2P to-MM events`);

      // Process events in chronological order
      const allEvents = [...onChainEvents, ...toMMEvents].sort((a, b) => a.blockNumber - b.blockNumber);

      for (const event of allEvents) {
        try {
          if (event.event === 'P2PTransferOnChain') {
            await this.processP2POnChainEvent(event);
          } else if (event.event === 'P2PTransferToMM') {
            await this.processP2PToMMEvent(event);
          }
        } catch (error) {
          logger.error(`❌ Error processing historical event ${event.transactionHash}:`, error);
          // Continue processing other events
        }
      }

      logger.info(`✅ Historical P2P event scan completed`);

    } catch (error) {
      logger.error('❌ Error scanning historical P2P events:', error);
      throw error;
    }
  }
}

module.exports = new P2PEventProcessor();
