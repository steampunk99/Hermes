// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./UGDxToken.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title UGDx Exchange
 * @dev Implementation of the exchange system for UGDx tokens
 * Allows users to swap between ETH and UGDx tokens
 * @custom:dev-run-script ./scripts/deploy_exchange.js
 */
contract Exchange is Ownable, Pausable, ReentrancyGuard {
    // State variables
    UGDxToken public ugdx;
    uint256 public constant EXCHANGE_RATE = 1000000; // 1 ETH = 1,000,000 UGDx
    
    // Events for tracking exchange operations
    event SwappedETHForUGDx(address indexed user, uint256 ethAmount, uint256 ugdxAmount);
    event SwappedUGDxForETH(address indexed user, uint256 ugdxAmount, uint256 ethAmount);
    event WithdrawalRequested(address indexed user, uint256 ugdxAmount);
    event LiquidityAdded(uint256 ethAmount, uint256 ugdxAmount);
    event LiquidityRemoved(uint256 ethAmount, uint256 ugdxAmount);

    /**
     * @dev Sets the UGDx token contract address
     * @param _ugdxToken The address of the UGDx token contract
     */
    constructor(address _ugdxToken) {
        require(_ugdxToken != address(0), "Exchange: Invalid token address");
        ugdx = UGDxToken(_ugdxToken);
    }

    /**
     * @dev Allows users to swap ETH for UGDx tokens
     * Requirements:
     * - Must send ETH with the transaction
     * - Exchange must have enough UGDx tokens
     * - Contract must not be paused
     */
    function swapETHForUGDx() external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "Exchange: Must send ETH");
        
        uint256 ugdxAmount = msg.value * EXCHANGE_RATE;
        require(ugdx.balanceOf(address(this)) >= ugdxAmount, "Exchange: Insufficient liquidity");
        
        bool success = ugdx.transfer(msg.sender, ugdxAmount);
        require(success, "Exchange: UGDx transfer failed");
        
        emit SwappedETHForUGDx(msg.sender, msg.value, ugdxAmount);
    }

    /**
     * @dev Allows users to swap UGDx tokens for ETH
     * Requirements:
     * - Amount must be greater than 0
     * - Exchange must have enough ETH
     * - User must have approved the exchange to spend their UGDx
     * - Contract must not be paused
     * @param ugdxAmount Amount of UGDx tokens to swap
     */
    function swapUGDxForETH(uint256 ugdxAmount) external nonReentrant whenNotPaused {
        require(ugdxAmount > 0, "Exchange: Amount must be positive");
        
        uint256 ethAmount = ugdxAmount / EXCHANGE_RATE;
        require(address(this).balance >= ethAmount, "Exchange: Insufficient ETH liquidity");
        
        require(
            ugdx.transferFrom(msg.sender, address(this), ugdxAmount),
            "Exchange: UGDx transfer failed"
        );
        
        (bool sent, ) = msg.sender.call{value: ethAmount}("");
        require(sent, "Exchange: ETH transfer failed");
        
        emit SwappedUGDxForETH(msg.sender, ugdxAmount, ethAmount);
    }

    /**
     * @dev Allows users to request withdrawal by burning UGDx tokens
     * Requirements:
     * - Amount must be greater than 0
     * - User must have enough UGDx tokens
     * - Contract must not be paused
     * @param amount Amount of UGDx tokens to burn
     */
    function requestWithdrawal(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Exchange: Amount must be positive");
        require(ugdx.balanceOf(msg.sender) >= amount, "Exchange: Insufficient balance");
        
        ugdx.burn(amount);
        emit WithdrawalRequested(msg.sender, amount);
    }

    /**
     * @dev Allows owner to add liquidity to the exchange
     * Requirements:
     * - Must send ETH with the transaction
     * - Must approve UGDx tokens to be transferred
     * - Only owner can call this function
     * @param ugdxAmount Amount of UGDx tokens to add as liquidity
     */
    function addLiquidity(uint256 ugdxAmount) external payable onlyOwner {
        require(msg.value > 0, "Exchange: Must send ETH");
        require(ugdxAmount > 0, "Exchange: Must send UGDx");
        
        require(
            ugdx.transferFrom(msg.sender, address(this), ugdxAmount),
            "Exchange: UGDx transfer failed"
        );
        
        emit LiquidityAdded(msg.value, ugdxAmount);
    }

    /**
     * @dev Allows owner to remove liquidity from the exchange
     * Requirements:
     * - Must specify amounts greater than 0
     * - Exchange must have enough of both assets
     * - Only owner can call this function
     * @param ethAmount Amount of ETH to remove
     * @param ugdxAmount Amount of UGDx tokens to remove
     */
    function removeLiquidity(
        uint256 ethAmount,
        uint256 ugdxAmount
    ) external onlyOwner nonReentrant {
        require(ethAmount > 0 && ugdxAmount > 0, "Exchange: Amounts must be positive");
        require(address(this).balance >= ethAmount, "Exchange: Insufficient ETH");
        require(ugdx.balanceOf(address(this)) >= ugdxAmount, "Exchange: Insufficient UGDx");

        (bool sent, ) = msg.sender.call{value: ethAmount}("");
        require(sent, "Exchange: ETH transfer failed");
        
        require(
            ugdx.transfer(msg.sender, ugdxAmount),
            "Exchange: UGDx transfer failed"
        );

        emit LiquidityRemoved(ethAmount, ugdxAmount);
    }

    /**
     * @dev Pauses the contract
     * Requirements:
     * - Only owner can call this function
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpauses the contract
     * Requirements:
     * - Only owner can call this function
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Allows the contract to receive ETH
     */
    receive() external payable {}
