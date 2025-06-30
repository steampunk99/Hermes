// src/config/index.js
require('dotenv').config();  // Load .env file

const { PrismaClient } = require('@prisma/client');
const winston = require('winston');
const { ethers } = require('ethers');

// Initialize Prisma Client for DB access
const prisma = new PrismaClient();

// Set up Winston logger (console logging for simplicity)
const logger = winston.createLogger({
  level: 'info',
  transports: [ new winston.transports.Console() ],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  )
});

// Load environment variables for reuse
const JWT_SECRET = process.env.JWT_SECRET;
const PROVIDER_FEE_BPS = parseInt(process.env.PROVIDER_FEE_BPS || "50"); // e.g., 0.5% fee

// Configure Ethers provider (connect to Ethereum/Polygon network)
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
// Create a signer from relayer private key (this account pays gas for meta-tx)
const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

// ABI definitions for required contract functions (UGDX token and Bridge)
const UGDX_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function mint(address to, uint256 amount) public",           // owner-only
  "function burn(uint256 amount) public",                       // if owner-only, contract must hold tokens
  "function burnFrom(address account, uint256 amount) public"   // optional, if implemented
];
const BRIDGE_ABI = [
  "function burnForWithdrawal(uint256 amount) public",          // user burns UGDX via Bridge (meta-tx friendly) 
  "function SwapUSDTForUGDX(uint256 usdtAmount) public",        // swap USDT to mint UGDX (not used in direct MM flow)
  "function ugxPerUSD() view returns(uint256)",                 // exchange rate (UGX per 1 USD)
  "function useOracleForPricing() view returns(bool)",
  "function priceOracle() view returns(address)"
];
const FORWARDER_ABI = [
  // Minimal Forwarder ABI (OpenZeppelin ERC2771 minimal forwarder functions)
  "function execute(address to, bytes memory data, address from, uint256 nonce, bytes signature) public returns (bool, bytes memory)",
  "function getNonce(address from) public view returns (uint256)"
];

// Initialize contract instances with Ethers
const ugdxContract = new ethers.Contract(process.env.UGDX_CONTRACT_ADDRESS, UGDX_ABI, relayer);
const bridgeContract = new ethers.Contract(process.env.BRIDGE_CONTRACT_ADDRESS, BRIDGE_ABI, relayer);
const forwarderContract = new ethers.Contract(process.env.FORWARDER_CONTRACT_ADDRESS, FORWARDER_ABI, relayer);

// Export all common configs
module.exports = {
  prisma,
  logger,
  JWT_SECRET,
  provider,
  relayer,
  ugdxContract,
  bridgeContract,
  forwarderContract,
  PROVIDER_FEE_BPS
};
