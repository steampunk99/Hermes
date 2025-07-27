// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "./Coin.sol";
import "./Oracle.sol";

/**
 * @title UGDX Bridge Contract with P2P Integration
 * @dev Main bridge contract handling USDT ↔ UGDX swaps, mobile money withdrawals, and P2P monitoring
 * @notice This contract manages conversions and provides analytics for the entire UGDX ecosystem
 */

contract UGDXBridge is Ownable, Pausable, ReentrancyGuard, ERC2771Context {
    using SafeERC20 for IERC20;

    // Contract instances
    UGDX public immutable ugdxToken;
    IERC20 public immutable usdtToken;

    IPriceOracle public priceOracle;
    uint256 public maxPriceAgeForSwaps = 3600; // 1 hour max
    bool public useOracleForPricing = false;

    // Exchange rate: how many UGX per 1 USD with 18 decimals
    uint256 public ugxPerUSD = 3700 * 10**18;

    // Fee settings in basis points
    uint256 public swapFeeBps = 50; // 0.5%
    uint256 public burnFeeBps = 25; // 0.25% default
    uint256 public constant MAX_FEE_BPS = 500; // 5%

    // Fee recipient
    address public feeRecipient;

    // Reserve tracking
    uint256 public totalUSDTReserves;
    uint256 public totalUGDXMinted;

    // === P2P INTEGRATION ===
    
    // P2P Analytics Storage
    struct P2PMetrics {
        uint256 totalOnChainTransfers;
        uint256 totalMMTransfers;
        uint256 totalP2PVolume;
        uint256 totalP2PFees;
        uint256 dailyP2PCount;
        uint256 lastDayReset;
    }
    
    P2PMetrics public p2pMetrics;
    
    // Daily P2P limits (anti-money laundering)
    uint256 public dailyP2PLimit = 50000000 * 10**18; // 50M UGDX per day
    mapping(address => uint256) public userDailyP2P;
    mapping(address => uint256) public userLastP2PDay;
    
    // === ORIGINAL EVENTS ===
    event USDTSwappedForUGDX(address indexed user, uint256 usdtAmount, uint256 ugdxAmount, uint256 feeAmount, uint256 exchangeRate);
    event FeeCollected(address indexed from, uint256 amount, string feeType);
    event UGDXBurnedForWithdrawal(address indexed user, uint256 ugdxAmount, uint256 timestamp);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event PricingModeChanged(bool useOracle);
    event SwapRejectedStalePrice(address indexed user, uint256 priceAge);
    event ExchangeRateUpdated(uint256 oldRate, uint256 newRate, uint256 timestamp);
    event SwapFeeUpdated(uint256 oldFee, uint256 newFee);
    event EmergencyWithdrawal(address indexed token, uint256 amount, address indexed to);
    event MobileMoneyMintUGDX(address indexed user, uint256 ugdxAmount, uint256 timestamp);
    
    // === P2P MONITORING EVENTS ===
    event P2PActivityDetected(address indexed user, uint256 amount, string transferType, uint256 timestamp);
    event P2PDailyLimitExceeded(address indexed user, uint256 attempted, uint256 limit);
    event P2PMetricsUpdated(uint256 totalVolume, uint256 dailyCount);

    constructor(
        address _ugdxToken,
        address _usdtToken,
        address _initialOwner,
        address trustedForwarder,
        address _priceOracle
    ) 
        Ownable(_initialOwner)
        ERC2771Context(trustedForwarder) 
    {
        require(_ugdxToken != address(0), "Bridge: Invalid UGDX address");
        require(_usdtToken != address(0), "Bridge: Invalid USDT address");

        ugdxToken = UGDX(_ugdxToken);
        usdtToken = IERC20(_usdtToken);

        if(_priceOracle != address(0)){
            try IPriceOracle(_priceOracle).getLatestPrice() returns (uint256, uint256, bool) {
                priceOracle = IPriceOracle(_priceOracle);
            } catch {
                revert("Bridge: Invalid oracle interface");
            }
        }
        
        feeRecipient = _initialOwner;
        
        // Initialize P2P metrics
        p2pMetrics.lastDayReset = block.timestamp;
    }

    // === P2P INTEGRATION FUNCTIONS ===
    
    /**
     * @dev Called by UGDX token contract to update P2P metrics
     * @param user Address performing P2P transfer
     * @param amount Amount being transferred
     * @param transferType "onchain" or "mm"
     */
    function updateP2PMetrics(
        address user,
        uint256 amount,
        string calldata transferType
    ) external {
        require(msg.sender == address(ugdxToken), "Bridge: Only UGDX token can call");
        
        // Reset daily counters if new day
        if (block.timestamp >= p2pMetrics.lastDayReset + 1 days) {
            p2pMetrics.dailyP2PCount = 0;
            p2pMetrics.lastDayReset = block.timestamp;
        }
        
        // Check daily limits for user
        uint256 currentDay = block.timestamp / 1 days;
        if (userLastP2PDay[user] != currentDay) {
            userDailyP2P[user] = 0;
            userLastP2PDay[user] = currentDay;
        }
        
        // Enforce daily limit
        if (userDailyP2P[user] + amount > dailyP2PLimit) {
            emit P2PDailyLimitExceeded(user, amount, dailyP2PLimit);
            revert("Bridge: Daily P2P limit exceeded");
        }
        
        // Update metrics
        userDailyP2P[user] += amount;
        p2pMetrics.totalP2PVolume += amount;
        p2pMetrics.dailyP2PCount += 1;
        
        if (keccak256(bytes(transferType)) == keccak256(bytes("onchain"))) {
            p2pMetrics.totalOnChainTransfers += 1;
        } else if (keccak256(bytes(transferType)) == keccak256(bytes("mm"))) {
            p2pMetrics.totalMMTransfers += 1;
        }
        
        emit P2PActivityDetected(user, amount, transferType, block.timestamp);
        emit P2PMetricsUpdated(p2pMetrics.totalP2PVolume, p2pMetrics.dailyP2PCount);
    }

       /**
     * @dev Set daily P2P limit for AML compliance
     */
    function setDailyP2PLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > 0, "Bridge: Invalid limit");
        dailyP2PLimit = newLimit;
    }
    
    /**
     * @dev Check user's remaining P2P limit for today
     */
    function getUserP2PLimit(address user) external view returns (uint256 remaining, uint256 used) {
        uint256 currentDay = block.timestamp / 1 days;
        
        if (userLastP2PDay[user] != currentDay) {
            return (dailyP2PLimit, 0);
        }
        
        used = userDailyP2P[user];
        remaining = dailyP2PLimit > used ? dailyP2PLimit - used : 0;
    }

       // === ENHANCED ANALYTICS ===
    
    /**
     * @dev Get comprehensive ecosystem metrics
     */
    function getEcosystemMetrics() external view returns (
        uint256 totalUSDTReserves_,
        uint256 totalUGDXMinted_,
        uint256 currentExchangeRate,
        uint256 totalP2PVolume,
        uint256 totalOnChainP2P,
        uint256 totalMMP2P,
        uint256 dailyP2PCount,
        uint256 avgP2PSize
    ) {
        uint256 currentRate = _getCurrentExchangeRate();
        
        uint256 avgSize = 0;
        if (p2pMetrics.totalOnChainTransfers + p2pMetrics.totalMMTransfers > 0) {
            avgSize = p2pMetrics.totalP2PVolume / (p2pMetrics.totalOnChainTransfers + p2pMetrics.totalMMTransfers);
        }
        
        return (
            totalUSDTReserves,
            totalUGDXMinted,
            currentRate,
            p2pMetrics.totalP2PVolume,
            p2pMetrics.totalOnChainTransfers,
            p2pMetrics.totalMMTransfers,
            p2pMetrics.dailyP2PCount,
            avgSize
        );
    }
    
    /**
     * @dev Reset P2P metrics (admin function for maintenance)
     */
    function resetP2PMetrics() external onlyOwner {
        delete p2pMetrics;
        p2pMetrics.lastDayReset = block.timestamp;
    }


    /**
     * @dev Swap USDT for UGDX tokens
     * @param usdtAmount Amount of USDT to swap (6 decimals for USDT)
     * 
     * Process:
     * 1. Take USDT from user
     * 2. Calculate UGDX amount using current exchange rate
     * 3. Deduct swap fee
     * 4. Mint UGDX to user
     */

     function SwapUSDTForUGDX(uint256 usdtAmount) external whenNotPaused nonReentrant {
        require(usdtAmount > 0, "Bridge: usdt amount must > 0");
        
        address sender = _msgSender();
        
        // Get current exchange rate (oracle or manual)
        uint256 currentRate = _getCurrentExchangeRate();
        require(currentRate > 0, "Bridge: Invalid exchange rate");
        
        // Transfer USDT from user to bridge
        usdtToken.safeTransferFrom(sender, address(this), usdtAmount);
        
        uint256 usdtAmountIn18Decimals = usdtAmount * 10**12;
        
        // Calculate UGDX amount using current rate
        uint256 ugdxAmountBeforeFee = (usdtAmountIn18Decimals * currentRate) / 10**18;
        
        // Calculate and deduct fee
        uint256 feeAmount = (ugdxAmountBeforeFee * swapFeeBps) / 10000;
        uint256 ugdxAmountAfterFee = ugdxAmountBeforeFee - feeAmount;

        // Update reserves
        totalUSDTReserves += usdtAmount;
        totalUGDXMinted += ugdxAmountAfterFee;

        // Mint UGDX to user
        ugdxToken.mint(sender, ugdxAmountAfterFee);
        // Mint fee to feeRecipient
        if (feeAmount > 0 && feeRecipient != address(0)) {
            ugdxToken.mint(feeRecipient, feeAmount);
            emit FeeCollected(sender, feeAmount, "swap");
        }

        emit USDTSwappedForUGDX(
            sender, 
            usdtAmount, 
            ugdxAmountAfterFee, 
            feeAmount, 
            currentRate // Now shows actual rate used
        );
    }

     /**
     * @dev Burn UGDX tokens for withdrawal (triggers off-chain processing)
     * @param ugdxAmount Amount of UGDX to burn (18 decimals)
     * 
     * Process:
     * 1. Burn UGDX from user's wallet
     * 2. Emit event for off-chain processor
     * 3. Backend matches tx hash to withdrawal request
     */

   function burnForWithdrawal(uint256 ugdxAmount) external whenNotPaused nonReentrant {
        require(ugdxAmount > 0, "Bridge: Amount must be > 0");
        address sender = _msgSender();
        require(ugdxToken.balanceOf(sender) >= ugdxAmount, "Insufficient balance");

        // Calculate burn fee
        uint256 feeAmount = (ugdxAmount * burnFeeBps) / 10000;
        uint256 burnAmount = ugdxAmount - feeAmount;

        // Burn net amount
        ugdxToken.burnFrom(sender, burnAmount);
        // Collect fee
        if (feeAmount > 0 && feeRecipient != address(0)) {
            ugdxToken.burnFrom(sender, feeAmount); // Optionally, could transfer to feeRecipient, but burning is more deflationary
            ugdxToken.mint(feeRecipient, feeAmount);
            emit FeeCollected(sender, feeAmount, "burn");
        }

        totalUGDXMinted -= ugdxAmount;
        emit UGDXBurnedForWithdrawal(sender, ugdxAmount, block.timestamp);
   }
        
    /**
     * @dev Set fee recipient address
     */

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Bridge: Invalid fee recipient");
        feeRecipient = newRecipient;
    }

    /**
     * @dev Update burn fee
     */
    function updateBurnFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "Bridge: Fee too high");
        burnFeeBps = newFeeBps;
    }


/**
 * @dev Emergency withdraw tokens (circuit breaker)
 * @param token Token address to withdraw
 * @param amount Amount to withdraw
 * @param to Recipient address
 */
function emergencyWithdraw(address token, uint256 amount, address to) external onlyOwner {
    require(to != address(0), "Bridge: Invalid recipient");
     if (token == address(usdtToken)) {
        uint256 maxWithdraw = totalUSDTReserves / 4; // Only 25% of user funds
        require(amount <= maxWithdraw, "Cannot drain user reserves");
    }
    IERC20(token).safeTransfer(to, amount);
    emit EmergencyWithdrawal(token, amount, to);
}


    /**
 * @dev Emergency pause bridge operations only
 */
function pauseBridge() external onlyOwner {
    _pause();
}

/**
 * @dev Resume bridge operations
 */
function unpauseBridge() external onlyOwner {
    _unpause();
}

/**
 * @dev Admin mint UGDX for manual mobile money payments
 * @param to Address to mint UGDX to
 * @param amount Amount of UGDX to mint (18 decimals)
 */
function adminMintUGDX(address to, uint256 amount) external onlyOwner {
    require(to != address(0), "Bridge: Invalid recipient");
    require(amount > 0, "Bridge: Invalid amount");
    
    // Update tracking
    totalUGDXMinted += amount;
    
    // Mint UGDX to recipient
    ugdxToken.mint(to, amount);
    
    // Emit proper mobile money mint event
    emit MobileMoneyMintUGDX(to, amount, block.timestamp);
}

/**
 * @dev Get current exchange rate from oracle or fallback to manual
 * @return rate Current UGX per USD rate (18 decimals)
 */
function _getCurrentExchangeRate() internal view returns (uint256) {
    if (useOracleForPricing) {
       
        (uint256 oracleRate, , ) = priceOracle.getLatestPrice();
        
        // Validate oracle rate isn't too far from manual rate
        uint256 maxDeviation = ugxPerUSD * 5 / 100; // 5% max deviation
        require(
            oracleRate <= ugxPerUSD + maxDeviation && 
            oracleRate >= ugxPerUSD - maxDeviation,
            "Oracle rate too far from manual rate"
        );
        
        return oracleRate;
    }
    return ugxPerUSD;
}


 /**
     * @dev Get current exchange rate with metadata (view function)
     * @return rate Current rate being used
     * @return source Source of the rate (0=manual, 1=oracle)
     * @return timestamp When rate was last updated
     * @return isValid Whether rate is considered valid
     */
    function getCurrentExchangeRate() external view returns (
        uint256 rate, 
        uint8 source, 
        uint256 timestamp, 
        bool isValid
    ) {
        if (useOracleForPricing && address(priceOracle) != address(0)) {
            (uint256 oracleRate, uint256 oracleTimestamp, bool oracleValid) = priceOracle.getLatestPrice();
            
            bool isPriceFresh = (block.timestamp - oracleTimestamp) <= maxPriceAgeForSwaps;
            
            return (
                oracleRate,
                1, // Oracle source
                oracleTimestamp,
                oracleValid && isPriceFresh
            );
        }
        
        return (
            ugxPerUSD,
            0, // Manual source  
            block.timestamp, // Manual rates are always "current"
            true
        );
    }


 /**
     * @dev UPDATED: Enhanced manual rate update with oracle coordination
     * @param newRate New manual rate (used as fallback)
     */
    function updateExchangeRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "Bridge: Invalid rate");
        
        // If using oracle, this just updates the fallback rate
        if (useOracleForPricing) {
            require(!priceOracle.isOracleHealthy(), "Bridge: Oracle healthy, manual override not needed");
        }
        
        // Prevent drastic rate changes (same as before)
        uint256 maxIncrease = ugxPerUSD * 120 / 100;
        uint256 maxDecrease = ugxPerUSD * 80 / 100;
        require(newRate <= maxIncrease && newRate >= maxDecrease, "Bridge: Rate change too large");
        
        uint256 oldRate = ugxPerUSD;
        ugxPerUSD = newRate;
        emit ExchangeRateUpdated(oldRate, newRate, block.timestamp);
    }

      /**
     * @dev Emergency function: Force manual pricing mode
     * Use this if oracle fails completely
     */
    function emergencyDisableOracle() external onlyOwner {
        useOracleForPricing = false;
        emit PricingModeChanged(false);
    }

    /**
     * @dev Enable or disable oracle-based pricing
     * @param useOracle Whether to use oracle for pricing
     */
    function setOraclePricingMode(bool useOracle) external onlyOwner {
        require(address(priceOracle) != address(0), "Bridge: Oracle not set");
        
        if (useOracle) {
            // Check oracle health
            require(priceOracle.isOracleHealthy(), "Bridge: Oracle not healthy");
            
            // Validate we can get a price
            (uint256 oracleRate, uint256 timestamp, bool isValid) = priceOracle.getLatestPrice();
            require(isValid, "Bridge: Oracle price invalid");
            require(block.timestamp - timestamp <= maxPriceAgeForSwaps, "Bridge: Oracle price too old");
            
            // Check price isn't too far from manual rate
            uint256 maxDeviation = ugxPerUSD * 5 / 100; // 5% max deviation
            require(
                oracleRate >= ugxPerUSD - maxDeviation && 
                oracleRate <= ugxPerUSD + maxDeviation,
                "Bridge: Oracle price deviation too high"
            );
        }
        
        useOracleForPricing = useOracle;
        emit PricingModeChanged(useOracle);
    }

/**
 * @dev Update swap fee with validation
 * @param newFeeBps New fee in basis points
 */
function updateSwapFee(uint256 newFeeBps) external onlyOwner {
    require(newFeeBps <= MAX_FEE_BPS, "Bridge: Fee too high");
    uint256 oldFee = swapFeeBps;
    swapFeeBps = newFeeBps;
    emit SwapFeeUpdated(oldFee, newFeeBps);
}


  // === MONITORING AND ANALYTICS ===

    /**
     * @dev Get comprehensive bridge status including oracle health
     */
    function getBridgeStatus() external view returns (
        uint256 currentRate,
        uint8 rateSource,
        uint256 rateTimestamp,
        bool rateIsValid,
        bool oracleHealthy,
        uint256 usdtReserves,
        uint256 ugdxMinted,
        uint256 currentFee,
        bool isPaused
    ) {
        (currentRate, rateSource, rateTimestamp, rateIsValid) = this.getCurrentExchangeRate();
        
        bool oracleHealth = false;
        if (address(priceOracle) != address(0)) {
            oracleHealth = priceOracle.isOracleHealthy();
        }
        
        return (
            currentRate,
            rateSource,
            rateTimestamp,
            rateIsValid,
            oracleHealth,
            totalUSDTReserves,
            totalUGDXMinted,
            swapFeeBps,
            paused()
        );
    }

 /**
     * @dev Check if a swap would succeed with current conditions
     * @param usdtAmount Amount user wants to swap
     * @return swapPossible Whether swap would succeed
     * @return swapReason Reason if swap would fail
     * @return estimatedUGDX How much UGDX user would receive
     */
    function canSwap(uint256 usdtAmount) external view returns (
        bool swapPossible, 
        string memory swapReason, 
        uint256 estimatedUGDX
    ) {
        if (paused()) {
            return (false, "Bridge is paused", 0);
        }
        
        if (usdtAmount == 0) {
            return (false, "Amount must be > 0", 0);
        }
        
        // Check if we can get a valid rate
        try this.getCurrentExchangeRate() returns (uint256 rate, uint8, uint256, bool isValid) {
            if (!isValid) {
                return (false, "Price data too stale", 0);
            }
            
            // Calculate estimated output
            uint256 usdtIn18 = usdtAmount * 10**12;
            uint256 ugdxBeforeFee = (usdtIn18 * rate) / 10**18;
            uint256 feeAmount = (ugdxBeforeFee * swapFeeBps) / 10000;
            uint256 ugdxAfterFee = ugdxBeforeFee - feeAmount;
            
            return (true, "Swap would succeed", ugdxAfterFee);
            
        } catch {
            return (false, "Cannot get valid exchange rate", 0);
        }
    }



/**
 * @dev Check if bridge has sufficient USDT reserves for potential burns
 * @return hasLiquidity True if bridge can handle current UGDX supply
 */
function checkLiquidity() external view returns (bool hasLiquidity, uint256 shortfall) {
    // Calculate theoretical USDT needed if all UGDX was burned
    uint256 theoreticalUSDTNeeded = (totalUGDXMinted * 10**18 / ugxPerUSD) / 10**12;
    
    if (totalUSDTReserves >= theoreticalUSDTNeeded) {
        return (true, 0);
    } else {
        return (false, theoreticalUSDTNeeded - totalUSDTReserves);
    }
}

/**
 * @dev Get current reserves and metrics
 */
function getReserveMetrics() external view returns (
    uint256 usdtReserves,
    uint256 ugdxMinted,
    uint256 currentRate,
    uint256 currentFee,
    bool isPaused
) {
    return (
        totalUSDTReserves,
        totalUGDXMinted,
        ugxPerUSD,
        swapFeeBps,
        paused()
    );
}

    function _msgSender() internal view virtual override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view virtual override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view virtual override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}