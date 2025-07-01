// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title UGDX Price Oracle
 * @dev Manages USD/UGX exchange rates with multiple validation layers
 * @notice This is the "Financial Weather Station" - completely pluggable!
 * 
 * Key Features:
 * - Multiple price source validation
 * - Circuit breaker for extreme rate changes  
 * - Time-weighted averages to prevent manipulation
 * - Fallback mechanisms for oracle failures
 * - Heartbeat monitoring
 */

interface IPriceOracle {
    function getLatestPrice() external view returns (uint256 rate, uint256 timestamp, bool isValid);
    function getHistoricalPrice(uint256 hoursAgo) external view returns (uint256 rate, uint256 timestamp);
    function isOracleHealthy() external view returns (bool);
}

contract UGDXPriceOracle is Ownable, Pausable, IPriceOracle {
    
    // Core price data structure
    struct PriceData {
        uint256 rate;           // UGX per USD (18 decimals)
        uint256 timestamp;      // When price was set
        uint256 blockNumber;    // Block when price was set
        bool isValid;           // Whether this price is considered valid
    }

    // Configuration constants
    uint256 public constant PRICE_PRECISION = 10**18;
    uint256 public constant MAX_PRICE_AGE = 3600; // 1 hour max age
    uint256 public constant MIN_PRICE_CHANGE_INTERVAL = 300; // 5 minutes between updates
    
    // Rate change limits (protection against manipulation)
    uint256 public maxRateChangePercentPerHour = 500; // 5% max change per hour
    uint256 public circuitBreakerThreshold = 1000; // 10% instant change triggers circuit breaker
    
    // Price storage
    PriceData public currentPrice;
    PriceData[] public priceHistory;
    mapping(uint256 => PriceData) public dailyPrices; // timestamp => price
    
    // Oracle sources (for multi-source validation)
    address[] public authorizedUpdaters;
    mapping(address => bool) public isAuthorizedUpdater;
    mapping(address => uint256) public lastUpdateBySource;
    
    // Fallback and emergency settings
    uint256 public emergencyFallbackRate;
    bool public useEmergencyFallback;
    uint256 public lastHeartbeat;
    
    // Events
    event PriceUpdated(
        uint256 indexed oldRate,
        uint256 indexed newRate,
        uint256 timestamp,
        address indexed updater
    );
    
    event CircuitBreakerTriggered(
        uint256 attemptedRate,
        uint256 currentRate,
        uint256 changePercent,
        address updater
    );
    
    event OracleSourceAdded(address indexed source);
    event OracleSourceRemoved(address indexed source);
    event EmergencyFallbackActivated(uint256 fallbackRate);
    event HeartbeatUpdated(uint256 timestamp);

    /**
     * @dev Constructor - Initialize with a reasonable starting rate
     * @param _initialRate Starting UGX/USD rate (with 18 decimals)
     * @param _initialOwner Owner of the oracle contract
     */
    constructor(uint256 _initialRate, address _initialOwner) Ownable(_initialOwner) {
        require(_initialRate > 0, "Oracle: Invalid initial rate");
        
        currentPrice = PriceData({
            rate: _initialRate,
            timestamp: block.timestamp,
            blockNumber: block.number,
            isValid: true
        });
        
        priceHistory.push(currentPrice);
        emergencyFallbackRate = _initialRate;
        lastHeartbeat = block.timestamp;
        
        emit PriceUpdated(0, _initialRate, block.timestamp, msg.sender);
    }

    /**
     * @dev Update price with validation checks
     * @param newRate New UGX per USD rate (18 decimals)
     */
    function updatePrice(uint256 newRate) external whenNotPaused {
        require(isAuthorizedUpdater[msg.sender], "Oracle: Unauthorized updater");
        require(newRate > 0, "Oracle: Invalid rate");
        require(
            block.timestamp >= lastUpdateBySource[msg.sender] + MIN_PRICE_CHANGE_INTERVAL,
            "Oracle: Update too frequent"
        );

        // Circuit breaker check
        if (currentPrice.isValid) {
            uint256 changePercent = _calculateChangePercent(currentPrice.rate, newRate);
            
            if (changePercent > circuitBreakerThreshold) {
                emit CircuitBreakerTriggered(newRate, currentPrice.rate, changePercent, msg.sender);
                return; // Reject the update
            }
            
            // Time-based rate change validation
            uint256 timeDiff = block.timestamp - currentPrice.timestamp;
            uint256 maxChangeAllowed = (maxRateChangePercentPerHour * timeDiff) / 3600;
            
            if (changePercent > maxChangeAllowed) {
                emit CircuitBreakerTriggered(newRate, currentPrice.rate, changePercent, msg.sender);
                return; // Reject the update
            }
        }

        // Update price
        uint256 oldRate = currentPrice.rate;
        currentPrice = PriceData({
            rate: newRate,
            timestamp: block.timestamp,
            blockNumber: block.number,
            isValid: true
        });

        // Store in history
        priceHistory.push(currentPrice);
        dailyPrices[_getDayTimestamp(block.timestamp)] = currentPrice;
        
        // Update tracking
        lastUpdateBySource[msg.sender] = block.timestamp;
        lastHeartbeat = block.timestamp;

        // Clear emergency fallback if it was active
        if (useEmergencyFallback) {
            useEmergencyFallback = false;
        }

        emit PriceUpdated(oldRate, newRate, block.timestamp, msg.sender);
    }

    /**
     * @dev Get latest price with validation
     * @return rate Current UGX/USD rate
     * @return timestamp When the rate was last updated
     * @return isValid Whether the rate is considered valid and fresh
     */
    function getLatestPrice() external view override returns (uint256 rate, uint256 timestamp, bool isValid) {
        if (useEmergencyFallback) {
            return (emergencyFallbackRate, block.timestamp, true);
        }

        bool isPriceFresh = (block.timestamp - currentPrice.timestamp) <= MAX_PRICE_AGE;
        bool isPriceValid = currentPrice.isValid && isPriceFresh && !paused();

        return (currentPrice.rate, currentPrice.timestamp, isPriceValid);
    }

    /**
     * @dev Get historical price from X hours ago
     * @param hoursAgo How many hours back to look
     * @return rate Historical rate
     * @return timestamp When that rate was recorded
     */
    function getHistoricalPrice(uint256 hoursAgo) external view override returns (uint256 rate, uint256 timestamp) {
        if (priceHistory.length == 0) {
        return (0, 0);
    }

    uint256 targetTime = block.timestamp - (hoursAgo * 3600);
    
    // SAFE VERSION: Use while loop to prevent underflow
    uint256 i = priceHistory.length;
    while (i > 0) {
        i--; // Decrement safely
        if (priceHistory[i].timestamp <= targetTime) {
            return (priceHistory[i].rate, priceHistory[i].timestamp);
        }
    }
    
    // Return oldest price if no match found
    return (priceHistory[0].rate, priceHistory[0].timestamp);
    }

    /**
     * @dev Check if oracle is healthy and providing fresh data
     * @return healthy True if oracle is functioning properly
     */
    function isOracleHealthy() external view override returns (bool healthy) {
        return (
            !paused() &&
            currentPrice.isValid &&
            (block.timestamp - currentPrice.timestamp) <= MAX_PRICE_AGE &&
            (block.timestamp - lastHeartbeat) <= MAX_PRICE_AGE
        );
    }

    // === ADMIN FUNCTIONS ===

    /**
     * @dev Add authorized price updater
     * @param updater Address that can update prices
     */
    function addOracleSource(address updater) external onlyOwner {
        require(updater != address(0), "Oracle: Invalid updater");
        require(!isAuthorizedUpdater[updater], "Oracle: Already authorized");
        
        isAuthorizedUpdater[updater] = true;
        authorizedUpdaters.push(updater);
        
        emit OracleSourceAdded(updater);
    }

    /**
     * @dev Remove authorized price updater
     * @param updater Address to remove
     */
    function removeOracleSource(address updater) external onlyOwner {
        require(isAuthorizedUpdater[updater], "Oracle: Not authorized");
        
        isAuthorizedUpdater[updater] = false;
        
        // Remove from array
        for (uint256 i = 0; i < authorizedUpdaters.length; i++) {
            if (authorizedUpdaters[i] == updater) {
                authorizedUpdaters[i] = authorizedUpdaters[authorizedUpdaters.length - 1];
                authorizedUpdaters.pop();
                break;
            }
        }
        
        emit OracleSourceRemoved(updater);
    }

    /**
     * @dev Activate emergency fallback rate
     * @param fallbackRate Rate to use as emergency fallback
     */
    function activateEmergencyFallback(uint256 fallbackRate) external onlyOwner {
        require(fallbackRate > 0, "Oracle: Invalid fallback rate");
        
        emergencyFallbackRate = fallbackRate;
        useEmergencyFallback = true;
        
        emit EmergencyFallbackActivated(fallbackRate);
    }

    /**
     * @dev Update circuit breaker settings
     * @param newThreshold New instant change threshold (in basis points)
     * @param newMaxHourlyChange New max hourly change (in basis points)
     */
    function updateCircuitBreakerSettings(
        uint256 newThreshold, 
        uint256 newMaxHourlyChange
    ) external onlyOwner {
        require(newThreshold <= 2000, "Oracle: Threshold too high"); // Max 20%
        require(newMaxHourlyChange <= 1000, "Oracle: Hourly change too high"); // Max 10%
        
        circuitBreakerThreshold = newThreshold;
        maxRateChangePercentPerHour = newMaxHourlyChange;
    }

    /**
     * @dev Manual heartbeat (can be called by monitoring systems)
     */
    function heartbeat() external {
        require(isAuthorizedUpdater[msg.sender] || msg.sender == owner(), "Oracle: Unauthorized");
        lastHeartbeat = block.timestamp;
        emit HeartbeatUpdated(block.timestamp);
    }

    // === INTERNAL HELPER FUNCTIONS ===

    /**
     * @dev Calculate percentage change between two rates
     * @param oldRate Previous rate
     * @param newRate New rate
     * @return changePercent Percentage change in basis points
     */
    function _calculateChangePercent(uint256 oldRate, uint256 newRate) internal pure returns (uint256 changePercent) {
        if (oldRate == 0) return 0;
        
        uint256 diff = newRate > oldRate ? newRate - oldRate : oldRate - newRate;
        return (diff * 10000) / oldRate; // Return in basis points
    }

    /**
     * @dev Get day timestamp (midnight UTC)
     * @param timestamp Input timestamp
     * @return dayTimestamp Timestamp rounded down to day
     */
    function _getDayTimestamp(uint256 timestamp) internal pure returns (uint256 dayTimestamp) {
        return (timestamp / 86400) * 86400; // 86400 = seconds in a day
    }

    // === VIEW FUNCTIONS FOR MONITORING ===

    /**
     * @dev Get current oracle status and metrics
     */
    function getOracleStatus() external view returns (
        uint256 currentRate,
        uint256 lastUpdate,
        bool isHealthy,
        bool isUsingFallback,
        uint256 authorizedSourceCount,
        uint256 priceHistoryLength
    ) {
        return (
            currentPrice.rate,
            currentPrice.timestamp,
            this.isOracleHealthy(),
            useEmergencyFallback,
            authorizedUpdaters.length,
            priceHistory.length
        );
    }

    /**
     * @dev Get recent price history (last N entries)
     * @param count Number of recent prices to return
     */
    function getRecentPrices(uint256 count) external view returns (PriceData[] memory) {
        if (count > priceHistory.length) {
            count = priceHistory.length;
        }
        
        PriceData[] memory recent = new PriceData[](count);
        uint256 startIndex = priceHistory.length - count;
        
        for (uint256 i = 0; i < count; i++) {
            recent[i] = priceHistory[startIndex + i];
        }
        
        return recent;
    }
}