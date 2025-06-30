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
 * @title UGDX Bridge Contract
 * @dev Main bridge contract handling USDT ↔ UGDX swaps and mobile money withdrawals
 * @notice This contract manages the conversion between USDT and UGDX tokens,
 *         and facilitates burning UGDX for mobile money transfers
 */

contract UGDXBridge is Ownable, Pausable, ReentrancyGuard, ERC2771Context {
    using SafeERC20 for IERC20;

    //Contract instances
    UGDX public immutable ugdxToken;
    IERC20 public immutable usdtToken;

    //Exchange rate: how many ugx per 1 usd with 18d
    uint256 public ugxPerUSD = 3700 * 10**18;

    //fee settings in basis points
    uint256 public swapFeeBps = 50; //0.5%
    uint256 public constant MAX_FEE_BPS = 500; // 5%

    //Reserve tracking
    uint256 public totalUSDTReserves;
    uint256 public totalUGDXMinted;

    //Events for off-chain processing
    event USDTSwappedForUGDX(
        address indexed user,
        uint256 usdtAmount,
        uint256 ugdxAmount,
        uint256 feeAmount,
        uint256 exchangeRate
    );

    event UGDXBurnedForWithdrawal(
        address indexed user,
        uint256 ugdxAmount,
        uint256 timestamp
    );

    event ExchangeRateUpdated(uint256 oldRate, uint256 newRate, uint256 timestamp);
    event SwapFeeUpdated(uint256 oldFee, uint256 newFee);
    event EmergencyWithdrawal(address indexed token, uint256 amount, address indexed to);


    /**
     * @dev Constructor initializes the bridge with token addresses
     * @param _ugdxToken Address of the UGDX token contract
     * @param _usdtToken Address of the USDT token contract (Polygon)
     * @param _initialOwner Address that will own this contract
     * @param trustedForwarder The address of the trusted forwarder for meta-transactions
     */

    constructor(address _ugdxToken, address _usdtToken, address _initialOwner, address trustedForwarder,_priceOracle) 
    Ownable(_initialOwner)
    ERC2771Context(trustedForwarder) {
        require(_ugdxToken != address(0), "Bridge: Invalid ugdx address");
        require(_usdtToken != address(0), "Bridge: Invalid usdt address");

        ugdxToken = UGDX(_ugdxToken);
        usdtToken = IERC20(_usdtToken);

        if(_priceOracle != address(0)){
            priceOracle = IPriceOracle(_priceOracle);
        }
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
        require(ugdxToken.balanceOf(sender) >= ugdxAmount, "Bridge: insufficient tokens");

        //burn ugdx from user
        ugdxToken.burn(ugdxAmount);

        //update tracking
        totalUGDXMinted -= ugdxAmount;

        emit UGDXBurnedForWithdrawal(sender, ugdxAmount,block.timestamp);
    }

/**
 * @dev Emergency withdraw tokens (circuit breaker)
 * @param token Token address to withdraw
 * @param amount Amount to withdraw
 * @param to Recipient address
 */
function emergencyWithdraw(address token, uint256 amount, address to) external onlyOwner {
    require(to != address(0), "Bridge: Invalid recipient");
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
     * @dev Get current exchange rate from oracle or fallback to manual
     * @return rate Current UGX per USD rate (18 decimals)
     */
 function _getCurrentExchangeRate() internal view returns (uint256 rate) {
        if (useOracleForPricing && address(priceOracle) != address(0)) {
            (uint256 oracleRate, uint256 timestamp, bool isValid) = priceOracle.getLatestPrice();
            
            // Check if oracle price is fresh and valid
            if (isValid && (block.timestamp - timestamp) <= maxPriceAgeForSwaps) {
                return oracleRate;
            }
            
            // Oracle price is stale or invalid, reject swap
            revert("Bridge: Oracle price too stale for swap");
        }
        
        // Fallback to manual rate
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
     * @return canSwap Whether swap would succeed
     * @return reason Reason if swap would fail
     * @return estimatedUGDX How much UGDX user would receive
     */
    function canSwap(uint256 usdtAmount) external view returns (
        bool canSwap, 
        string memory reason, 
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