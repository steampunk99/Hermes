
require('dotenv').config();
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
    winston.format.cli()
  )
});

// Load environment variables for reuse
const JWT_SECRET = process.env.JWT_SECRET;
const PROVIDER_FEE_BPS = parseInt(process.env.PROVIDER_FEE_BPS || "50"); // e.g., 0.5% fee

// Configure Ethers providers (connect to Ethereum/Polygon network)
// HTTP provider for regular transactions
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
// WebSocket provider for event listening (if WS URL is provided)
const wsProvider = process.env.RPC_WS_URL ? new ethers.WebSocketProvider(process.env.RPC_WS_URL) : null;
// Create a signer from relayer private key (this account pays gas for meta-tx)
const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

// ABI definitions for required contract functions (UGDX token and Bridge)
const UGDX_ABI = [
  // Basic ERC20 functions
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function mint(address to, uint256 amount) public",           // owner-only
  "function burn(uint256 amount) public",                       // if owner-only, contract must hold tokens
  "function burnFrom(address account, uint256 amount) public",   // optional, if implemented
  
  // P2P functions
  "function sendP2POnChain(address to, uint256 amount, string calldata memo, bool payGasInTokens) external",
  "function sendP2PToMM(string calldata recipientPhone, uint256 amount, string calldata memo, bool payGasInTokens) external",
  
  // P2P events
  "event P2PTransferOnChain(address indexed from, address indexed to, uint256 amount, uint256 fee, string memo, uint256 timestamp)",
  "event P2PTransferToMM(address indexed from, string indexed recipientPhone, uint256 amount, uint256 fee, string memo, uint256 timestamp)",
  
  // Gas payment event
  "event GasPaidInTokens(address indexed user, uint256 gasAmount, uint256 nonce)"
];
const BRIDGE_ABI = [
  // Core swap functions
  "function burnForWithdrawal(uint256 amount) external",          
  "function SwapUSDTForUGDX(uint256 usdtAmount) external",        
  
  // Admin functions
  "function adminMintUGDX(address to, uint256 amount) external",
  
  // View functions
  "function ugxPerUSD() view returns(uint256)",                 
  "function useOracleForPricing() view returns(bool)",
  "function priceOracle() view returns(address)",
  "function owner() view returns (address)",
  "function getBridgeStatus() view returns (uint256 currentRate, uint8 rateSource, uint256 rateTimestamp, bool rateIsValid, bool oracleHealthy, uint256 usdtReserves, uint256 ugdxMinted, uint256 currentFee, bool isPaused)",
  
  // Oracle management
  "function setOraclePricingMode(bool useOracle) external",
  
  // Events
  "event PricingModeChanged(bool useOracle)",
  "event OracleUpdated(address indexed oldOracle, address indexed newOracle)",
  "event MobileMoneyMintUGDX(address indexed user, uint256 ugdxAmount, uint256 timestamp)",
  "event UGDXBurnedForWithdrawal(address indexed user, uint256 ugdxAmount, uint256 timestamp)",
  "event FeeCollected(address indexed from, uint256 amount, string feeType)",
  "event USDTSwappedForUGDX(address indexed user, uint256 usdtAmount, uint256 ugdxAmount, uint256 feeAmount, uint256 exchangeRate)",
  
  // P2P monitoring events
  "event P2PActivityDetected(address indexed user, uint256 amount, string transferType, uint256 timestamp)",
  "event P2PDailyLimitExceeded(address indexed user, uint256 attempted, uint256 limit)",
  "event P2PMetricsUpdated(uint256 totalVolume, uint256 dailyCount)"
];
const FORWARDER_ABI = [
  // Correct ABI for OpenZeppelin ERC2771Forwarder
  "function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data, uint256 validUntil) calldata req, bytes calldata signature) public returns (bool, bytes memory)",
  "function getNonce(address from) public view returns (uint256)",
  "function verify((address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data) req, bytes signature) external view returns (bool)",
  "function getNonce(address from) external view returns (uint256)",
  "function nonces(address from) external view returns (uint256)",
];

const ORACLE_ABI = [
  "function updatePrice(uint256 newRate) external",
  "function getLatestPrice() external view returns (uint256, uint256, bool)",
  "function isOracleHealthy() external view returns (bool)",
  "function owner() external view returns (address)",
  "function isAuthorizedUpdater(address) external view returns (bool)",
  "function addOracleSource(address updater) external"  // Added for authorization management
];

// Initialize contract instances with Ethers
const ugdxContract = new ethers.Contract(process.env.UGDX_CONTRACT_ADDRESS, UGDX_ABI, relayer);
const bridgeContract = new ethers.Contract(process.env.BRIDGE_CONTRACT_ADDRESS, BRIDGE_ABI, relayer);
const forwarderContract = new ethers.Contract(process.env.FORWARDER_CONTRACT_ADDRESS, FORWARDER_ABI, relayer);
const oracleContract = new ethers.Contract(process.env.ORACLE_CONTRACT_ADDRESS, ORACLE_ABI, relayer);

// Export all common configs
module.exports = {
  prisma,
  logger,
  JWT_SECRET,
  provider,
  wsProvider,
  relayer,
  ugdxContract,
  bridgeContract,
  forwarderContract,
  oracleContract,
  PROVIDER_FEE_BPS
};
