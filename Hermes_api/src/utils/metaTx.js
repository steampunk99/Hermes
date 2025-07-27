// src/utils/metaTx.js
const { ethers } = require('ethers');
const { logger } = require('../config');

/**
 * Meta-transaction utilities for ERC2771 forwarder integration
 * Handles signature creation, validation, and execution
 * Updated for ethers v6
 */

/**
 * Create a meta-transaction request structure
 * @param {string} from - User address
 * @param {string} to - Target contract address
 * @param {string} data - Encoded function call data
 * @param {bigint} nonce - User's current nonce (now bigint in v6)
 * @param {number} chainId - Network chain ID
 * @param {string} forwarderAddress - Forwarder contract address
 * @returns {Object} Meta-transaction request object
 */
function createMetaTxRequest(from, to, data, nonce, chainId, forwarderAddress) {
  return {
    from,
    to,
    value: 0n, // Always 0n (bigint) for our use case
    gas: 300000n, // Gas limit as bigint (approx for P2P transfer)
    nonce,
    data,
    validUntil: 0n,

  };
}

/**
 * Get the EIP-712 domain for the forwarder
 * @param {number} chainId - Network chain ID
 * @param {string} forwarderAddress - Forwarder contract address
 * @returns {Object} EIP-712 domain
 */
function getForwarderDomain(chainId, forwarderAddress) {
  return {
    name: 'ERC2771Forwarder',
    version: '0.0.1',
    chainId,
    verifyingContract: forwarderAddress,
  };
}

/**
 * Get the EIP-712 types for meta-transaction
 * @returns {Object} EIP-712 types
 */
function getMetaTxTypes() {
  return {
    ForwardRequest: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'gas', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'validUntil', type: 'uint256' }
    ],
  };
}

/**
 * Create a signature for a meta-transaction request
 * @param {Object} request - Meta-transaction request
 * @param {Object} domain - EIP-712 domain
 * @param {ethers.Wallet} signer - User's wallet for signing
 * @returns {string} Signature
 */
async function signMetaTxRequest(request, domain, signer) {
  const types = getMetaTxTypes();
  
  try {
    // v6: signTypedData method signature remains the same
    const signature = await signer.signTypedData(domain, types, request);
    return signature;
  } catch (error) {
    logger.error('Failed to sign meta-transaction:', error);
    throw new Error('Signature creation failed');
  }
}

/**
 * Verify a meta-transaction signature
 * @param {Object} request - Meta-transaction request
 * @param {string} signature - Signature to verify
 * @param {number} chainId - Network chain ID
 * @param {string} forwarderAddress - Forwarder contract address
 * @returns {boolean} True if signature is valid
 */
function verifyMetaTxSignature(request, signature, chainId, forwarderAddress) {
  try {
    const domain = getForwarderDomain(chainId, forwarderAddress);
    const types = getMetaTxTypes();
    
    // v6: verifyTypedData is now a static method on ethers (no change needed)
    const recoveredAddress = ethers.verifyTypedData(domain, types, request, signature);
    return recoveredAddress.toLowerCase() === request.from.toLowerCase();
  } catch (error) {
    logger.error('Signature verification failed:', error);
    return false;
  }
}

/**
 * Execute a meta-transaction through the forwarder
 * @param {Object} forwarderContract - Forwarder contract instance
 * @param {Object} request - Meta-transaction request
 * @param {string} signature - User's signature
 * @returns {Object} Transaction receipt
 */
async function executeMetaTx(forwarderContract, request, signature) {
  try {
    logger.info(`[EXECUTE DEBUG] Received request:`, {
      from: request?.from,
      to: request?.to,
      value: request?.value?.toString(),
      gas: request?.gas?.toString(),
      nonce: request?.nonce?.toString(),
      data: request?.data
    });
    try {
      await forwarderContract.execute.staticCall(request, signature);
      // If staticCall passes the tx itself should succeed
      console.log('✅ staticCall succeeded – should execute');
    } catch (err) {
      console.error('⚠️ Revert reason:', err.reason);   // <- exact require() message
      throw err;
    }
    logger.info(`[EXECUTE DEBUG] Received signature:`, signature);
    logger.info(`Executing meta-transaction for from: ${request.from}, to: ${request.to}`);
    logger.info('[DEBUG] MetaTxRequest:', {
      from: request.from,
      to: request.to,
      value: request.value?.toString(),
      gas: request.gas?.toString(),
      nonce: request.nonce?.toString(),
      data: request.data
    });
    logger.info('[DEBUG] Signature:', signature);

    // Execute the meta-transaction
    logger.info(`[EXECUTION] About to call forwarderContract.execute()`);
    const tx = await forwarderContract.execute(request, signature);
    logger.info(`[EXECUTION] Transaction sent. Tx hash: ${tx.hash}`);
    logger.info(`[EXECUTION] Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    logger.info(`✅ Meta-transaction confirmed. Tx hash: ${receipt.hash}`);
    
    return { 
      success: true, 
      txHash: receipt.hash,
      receipt: receipt
    };
  } catch (error) {
    logger.error(`❌ Meta-transaction execution failed:`, {
      message: error.message,
      code: error.code,
      reason: error.reason,
      stack: error.stack
    });
    
    // Try to get more detailed error info
    if (error.transaction) {
      logger.error(`[EXECUTION] Failed transaction data:`, {
        data: error.transaction.data,
        to: error.transaction.to
      });
    }
    
    if (error.receipt) {
      logger.error(`[EXECUTION] Transaction receipt:`, error.receipt);
    }
    
    return { 
      success: false, 
      error: error.message || 'Unknown error',
      code: error.code,
      reason: error.reason,
      stack: error.stack
    };
  }
}

/**
 * Get contract address in v6 compatible way
 * @param {Object} contract - Contract instance
 * @returns {string} Contract address
 */
function getContractAddress(contract) {
  // v6: contracts now use 'target' instead of 'address'
  // But we'll be defensive and check both for compatibility
  return contract.target || contract.address;
}

/**
 * Create a meta-transaction for UGDX transfer
 * @param {string} userAddress - User's address
 * @param {string} targetAddress - Recipient address
 * @param {string} amount - Amount in wei
 * @param {Object} ugdxContract - UGDX contract instance
 * @param {Object} forwarderContract - Forwarder contract instance
 * @param {number} chainId - Network chain ID
 * @returns {Object} Meta-transaction request
 */
async function createUGDXTransferMetaTx(userAddress, targetAddress, amount, ugdxContract, forwarderContract, chainId) {
  // v6: encodeFunctionData remains the same
  const data = ugdxContract.interface.encodeFunctionData('transfer', [targetAddress, amount]);
  
  // Get user's nonce (will be returned as bigint in v6)
  const nonce = await forwarderContract.nonces(userAddress);
  
  // Create meta-transaction request
  const request = createMetaTxRequest(
    userAddress,
    getContractAddress(ugdxContract),
    data,
    nonce,
    chainId,
    getContractAddress(forwarderContract)
  );
  
  return request;
}

/**
 * Create a meta-transaction for bridge burn
 * @param {string} userAddress - User's address
 * @param {string} amount - Amount in wei
 * @param {Object} bridgeContract - Bridge contract instance
 * @param {Object} forwarderContract - Forwarder contract instance
 * @param {number} chainId - Network chain ID
 * @returns {Object} Meta-transaction request
 */
async function createBridgeBurnMetaTx(userAddress, amount, bridgeContract, forwarderContract, chainId) {
  // Encode the burnForWithdrawal function call
  const data = bridgeContract.interface.encodeFunctionData('burnForWithdrawal', [amount]);
  
  // Get user's nonce
  const nonce = await forwarderContract.nonces(userAddress);
  
  // Create meta-transaction request
  const request = createMetaTxRequest(
    userAddress,
    getContractAddress(bridgeContract),
    data,
    nonce,
    chainId,
    getContractAddress(forwarderContract)
  );
  
  return request;
}

/**
 * Create a meta-transaction for P2P on-chain transfer
 * @param {string} userAddress - User's address
 * @param {string} recipientAddress - Recipient address
 * @param {string} amount - Amount in wei
 * @param {string} memo - Transfer memo
 * @param {boolean} payGasInTokens - Whether to pay gas in tokens
 * @param {Object} ugdxContract - UGDX contract instance
 * @param {Object} forwarderContract - Forwarder contract instance
 * @param {number} chainId - Network chain ID
 * @returns {Object} Meta-transaction request
 */


async function createP2POnChainMetaTx(userAddress, recipientAddress, amount, memo, payGasInTokens, ugdxContract, forwarderContract, chainId) {
  
    console.log('🔍 ugdxContract:', ugdxContract);
    console.log('🔍 Is undefined?', ugdxContract === undefined);
    console.log('🔍 Type:', typeof ugdxContract);

    // Encode the sendP2POnChain function call
  const data = ugdxContract.interface.encodeFunctionData('sendP2POnChain', [
    recipientAddress,
    amount,
    memo,
    payGasInTokens
  ]);
  
  // Get user's nonce
  const nonce = await forwarderContract.nonces(userAddress);
  
  // Create meta-transaction request
  const request = createMetaTxRequest(
    userAddress,
    getContractAddress(ugdxContract),
    data,
    nonce,
    chainId,
    getContractAddress(forwarderContract)
  );
  
  return request;
}

/**
 * Create a meta-transaction for P2P to mobile money transfer
 * @param {string} userAddress - User's address
 * @param {string} recipientPhone - Recipient phone number
 * @param {string} amount - Amount in wei
 * @param {string} memo - Transfer memo
 * @param {boolean} payGasInTokens - Whether to pay gas in tokens
 * @param {Object} ugdxContract - UGDX contract instance
 * @param {Object} forwarderContract - Forwarder contract instance
 * @param {number} chainId - Network chain ID
 * @returns {Object} Meta-transaction request
 */
async function createP2PToMMMetaTx(userAddress, recipientPhone, amount, memo, payGasInTokens, ugdxContract, forwarderContract, chainId) {
  // Encode the sendP2PToMM function call
  const data = ugdxContract.interface.encodeFunctionData('sendP2PToMM', [
    recipientPhone,
    amount,
    memo,
    payGasInTokens
  ]);
  
  // Get user's nonce
  const nonce = await forwarderContract.nonces(userAddress);
  
  // Create meta-transaction request
  const request = createMetaTxRequest(
    userAddress,
    getContractAddress(ugdxContract),
    data,
    nonce,
    chainId,
    getContractAddress(forwarderContract)
  );
  
  return request;
}

/**
 * Create and sign a meta-transaction from the backend using the relayer
 * @param {string} userAddress - The user's address (the 'from' address)
 * @param {string} recipientAddress - The recipient of the P2P transfer
 * @param {string} amount - The amount to send (in ether format, e.g., "100")
 * @param {string} memo - The transaction memo
 * @param {object} contracts - An object containing ugdxContract, forwarderContract
 * @param {object} relayer - The relayer wallet instance for signing
 * @param {object} provider - The ethers provider
 * @returns {{metaTxRequest: object, signature: string}} - The request and signature
 */
async function createAndSignP2POnChainMetaTx(userAddress, recipientAddress, amount, memo, contracts, relayer, provider) {
  try {
    logger.info(`🔍 Starting meta-tx creation for user: ${userAddress}`);
    
    const { ugdxContract, forwarderContract } = contracts;
    logger.info(`🔍 Contracts received - UGDX: ${ugdxContract?.target}, Forwarder: ${forwarderContract?.target}`);
    
    const { chainId } = await provider.getNetwork();
    logger.info(`🔍 Chain ID: ${chainId}`);

    // 1. Create the unsigned meta-transaction request
    logger.info(`🔍 Creating P2P meta-tx request...`);
    const metaTxRequest = await createP2POnChainMetaTx(
      userAddress,
      recipientAddress,
      ethers.parseEther(amount.toString()),
      memo,
      true, // payGasInTokens
      ugdxContract,
      forwarderContract,
      chainId
    );
    logger.info(`✅ Meta-tx request created successfully`);

    // 2. Get the domain and types for signing
    logger.info(`🔍 Getting domain and types for signing...`);
    const domain = getForwarderDomain(chainId, getContractAddress(forwarderContract));
    const types = getMetaTxTypes();
    logger.info(`✅ Domain and types ready`);

    // 3. Sign the request with the backend relayer wallet
    logger.info(`🔍 Signing meta-tx with relayer...`);
    const signature = await relayer.signTypedData(domain, types, metaTxRequest);
    logger.info(`✅ Meta-tx signed successfully`);

    const result = { metaTxRequest, signature };
    console.log('[DEBUG] Returning from createAndSignP2POnChainMetaTx:', JSON.stringify(result, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    return result;
  } catch (error) {
    logger.error(`❌ createAndSignP2POnChainMetaTx failed:`, error);
    throw error;
  }
}

module.exports = {
  createMetaTxRequest,
  getForwarderDomain,
  getMetaTxTypes,
  signMetaTxRequest,
  verifyMetaTxSignature,
  executeMetaTx,
  createUGDXTransferMetaTx,
  createBridgeBurnMetaTx,
  createP2POnChainMetaTx,
  createP2PToMMMetaTx,
  createAndSignP2POnChainMetaTx,
  getContractAddress // Export utility function
};