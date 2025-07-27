// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UGDX TOKEN with P2P Module
 * @dev ERC20 Token pegged 1:1 to Ugandan Shilling with peer-to-peer features
 * 
 * Key Features:
 * - Only owner can mint new tokens
 * - Anyone can burn their tokens (for MM withdrawals)  
 * - P2P transfers: on-chain or burn-to-mobile-money
 * - Meta-transaction support with gas deduction
 * - Pausable for emergency situations
 * - 18 decimals for precision (1 UGDX = 1 UGX)
 */

contract UGDX is ERC20, Ownable, Pausable, ERC2771Context, ReentrancyGuard {
    
    // === P2P MODULE STORAGE ===
    
    // Gas price for meta-transactions (in UGDX tokens)
    uint256 public gasTokenPrice = 100 * 10**18; // 100 UGDX = 1 meta-tx
    
    // P2P transaction limits
    uint256 public maxP2PAmount = 10000000 * 10**18; // 10M UGDX max per tx
    uint256 public minP2PAmount = 1000 * 10**18;     // 1K UGDX minimum
    
    // P2P fee (in basis points)
    uint256 public p2pFeeBps = 10; // 0.1% default
    uint256 public constant MAX_P2P_FEE_BPS = 100; // 1% max
    
    // Fee recipient for P2P transactions
    address public p2pFeeRecipient;
    
    // Nonce tracking for meta-transactions
    mapping(address => uint256) public nonces;
    
    // === P2P EVENTS ===
    
    event P2PTransferOnChain(
        address indexed from,
        address indexed to, 
        uint256 amount,
        uint256 fee,
        string memo,
        uint256 timestamp
    );
    
    event P2PTransferToMM(
        address indexed from,
        string indexed recipientPhone, // For backend processing
        uint256 amount,
        uint256 fee,
        string memo,
        uint256 timestamp
    );
    
    event GasPaidInTokens(
        address indexed user,
        uint256 tokenAmount,
        uint256 nonce
    );
    
    // Original events
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);
    
    // === CONSTRUCTOR ===
    
    constructor(address _initialOwner, address trustedForwarder)
        ERC20("Uganda Shilling Token", "UGDX")
        Ownable(_initialOwner)
        ERC2771Context(trustedForwarder)
    {
        p2pFeeRecipient = _initialOwner;
    }
    
    // === P2P CORE FUNCTIONS ===
    
    /**
     * @dev Send UGDX directly to another address (on-chain P2P)
     * @param to Recipient address
     * @param amount Amount to send (18 decimals)
     * @param memo Optional message
     * @param payGasInTokens Whether to deduct gas from sender's balance
     */
    function sendP2POnChain(
        address to,
        uint256 amount,
        string calldata memo,
        bool payGasInTokens
    ) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        
        _validateP2PTransfer(sender, amount);
        require(to != address(0) && to != sender, "UGDX: Invalid recipient");
        
        // Handle gas payment if requested
        if (payGasInTokens) {
            _deductGasInTokens(sender);
        }
        
        // Calculate fee
        uint256 fee = (amount * p2pFeeBps) / 10000;
        uint256 netAmount = amount - fee;
        
        // Execute transfer
        _transfer(sender, to, netAmount);
        
        // Collect fee
        if (fee > 0 && p2pFeeRecipient != address(0)) {
            _transfer(sender, p2pFeeRecipient, fee);
        }
        
        emit P2PTransferOnChain(sender, to, netAmount, fee, memo, block.timestamp);
    }
    
    /**
     * @dev Send UGDX to mobile money recipient (burn tokens, trigger MM payment)
     * @param recipientPhone Phone number for MM transfer
     * @param amount Amount to send (18 decimals)
     * @param memo Optional message
     * @param payGasInTokens Whether to deduct gas from sender's balance
     */
    function sendP2PToMM(
        string calldata recipientPhone,
        uint256 amount,
        string calldata memo,
        bool payGasInTokens
    ) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        
        _validateP2PTransfer(sender, amount);
        require(bytes(recipientPhone).length > 0, "UGDX: Phone required");
        
        // Handle gas payment if requested
        if (payGasInTokens) {
            _deductGasInTokens(sender);
        }
        
        // Calculate fee
        uint256 fee = (amount * p2pFeeBps) / 10000;
        uint256 burnAmount = amount - fee;
        
        // Burn tokens (this triggers MM payment off-chain)
        _burn(sender, burnAmount);
        
        // Collect fee by transferring to fee recipient
        if (fee > 0 && p2pFeeRecipient != address(0)) {
            _transfer(sender, p2pFeeRecipient, fee);
        }
        
        emit P2PTransferToMM(sender, recipientPhone, burnAmount, fee, memo, block.timestamp);
    }
    
    // === META-TRANSACTION GAS HANDLING ===
    
    /**
     * @dev Deduct gas equivalent in UGDX tokens from user's balance
     * @param user Address to deduct gas from
     */
    function _deductGasInTokens(address user) internal {
        require(balanceOf(user) >= gasTokenPrice, "UGDX: Insufficient balance for gas");
        
        // Burn gas tokens (deflationary) or send to fee recipient
        if (p2pFeeRecipient != address(0)) {
            _transfer(user, p2pFeeRecipient, gasTokenPrice);
        } else {
            _burn(user, gasTokenPrice);
        }
        
        emit GasPaidInTokens(user, gasTokenPrice, nonces[user]++);
    }
    
    /**
     * @dev Validate P2P transfer parameters
     */
    function _validateP2PTransfer(address sender, uint256 amount) internal view {
        require(amount >= minP2PAmount, "UGDX: Amount below minimum");
        require(amount <= maxP2PAmount, "UGDX: Amount above maximum");
        
        // Calculate total cost (amount + potential fee + potential gas)
        uint256 fee = (amount * p2pFeeBps) / 10000;
        uint256 totalNeeded = amount + fee;
        
        require(balanceOf(sender) >= totalNeeded, "UGDX: Insufficient balance");
    }
    
    // === BATCH P2P FUNCTIONS ===
    
    /**
     * @dev Send to multiple recipients at once (gas efficient)
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts to send
     * @param memos Array of memos (optional)
     * @param payGasInTokens Whether to deduct gas once for batch
     */
    function batchSendP2POnChain(
        address[] calldata recipients,
        uint256[] calldata amounts, 
        string[] calldata memos,
        bool payGasInTokens
    ) external whenNotPaused nonReentrant {
        require(recipients.length == amounts.length, "UGDX: Array length mismatch");
        require(recipients.length <= 50, "UGDX: Batch too large"); // Prevent gas issues
        
        address sender = _msgSender();
        
        // Pay gas once for entire batch
        if (payGasInTokens) {
            _deductGasInTokens(sender);
        }
        
        // Process each transfer
        for (uint256 i = 0; i < recipients.length; i++) {
            if (amounts[i] == 0) continue; // Skip zero amounts
            
            _validateP2PTransfer(sender, amounts[i]);
            require(recipients[i] != address(0) && recipients[i] != sender, "UGDX: Invalid recipient");
            
            uint256 fee = (amounts[i] * p2pFeeBps) / 10000;
            uint256 netAmount = amounts[i] - fee;
            
            _transfer(sender, recipients[i], netAmount);
            
            if (fee > 0 && p2pFeeRecipient != address(0)) {
                _transfer(sender, p2pFeeRecipient, fee);
            }
            
            string memory memo = i < memos.length ? memos[i] : "";
            emit P2PTransferOnChain(sender, recipients[i], netAmount, fee, memo, block.timestamp);
        }
    }
    
    // === ADMIN FUNCTIONS ===
    
    /**
     * @dev Update gas price in tokens
     */
    function setGasTokenPrice(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "UGDX: Invalid gas price");
        gasTokenPrice = newPrice;
    }
    
    /**
     * @dev Update P2P fee
     */
    function setP2PFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_P2P_FEE_BPS, "UGDX: Fee too high");
        p2pFeeBps = newFeeBps;
    }
    
    /**
     * @dev Update P2P limits
     */
    function setP2PLimits(uint256 newMin, uint256 newMax) external onlyOwner {
        require(newMin > 0 && newMax > newMin, "UGDX: Invalid limits");
        minP2PAmount = newMin;
        maxP2PAmount = newMax;
    }
    
    /**
     * @dev Set P2P fee recipient
     */
    function setP2PFeeRecipient(address newRecipient) external onlyOwner {
        p2pFeeRecipient = newRecipient;
    }
    
    // === VIEW FUNCTIONS ===
    
    /**
     * @dev Calculate P2P transfer cost breakdown
     * @param amount Amount to send
     * @param includeGas Whether gas will be paid in tokens
     * @return netAmount Amount recipient receives
     * @return fee P2P fee
     * @return gasCost Gas cost in tokens (if applicable)
     * @return totalCost Total cost to sender
     */
    function calculateP2PCost(uint256 amount, bool includeGas) 
        external 
        view 
        returns (
            uint256 netAmount,
            uint256 fee, 
            uint256 gasCost,
            uint256 totalCost
        ) 
    {
        fee = (amount * p2pFeeBps) / 10000;
        netAmount = amount - fee;
        gasCost = includeGas ? gasTokenPrice : 0;
        totalCost = amount + gasCost;
    }
    
    /**
     * @dev Check if user can afford P2P transfer
     */
    function canAffordP2P(address user, uint256 amount, bool includeGas) 
        external 
        view 
        returns (bool canAfford, uint256 shortfall) 
    {
        (, , uint256 gasCost, uint256 totalCost) = this.calculateP2PCost(amount, includeGas);
        uint256 balance = balanceOf(user);
        
        if (balance >= totalCost) {
            return (true, 0);
        } else {
            return (false, totalCost - balance);
        }
    }
    
    // === ORIGINAL FUNCTIONS (unchanged) ===
    
    function mint(address to, uint256 amount) external onlyOwner whenNotPaused {
        require(amount > 0, "UGDX: Amount must be > 0");
        require(to != address(0), "Not a valid user address");
        
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }
    
    function burn(uint256 amount) external whenNotPaused {
        require(amount > 0, "UGDX: Burn amount must be > 0");
        require(balanceOf(msg.sender) >= amount, "UGDX: Insufficient Balance");
        
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }
    
    function burnFrom(address from, uint256 amount) external onlyOwner whenNotPaused {
        require(amount > 0, "UGDX: Burn amount must be > 0");
        require(balanceOf(from) >= amount, "UGDX: Insufficient balance");
        require(allowance(from, msg.sender) >= amount, "UGDX: Insufficient allowance");
        
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
        
        emit TokensBurned(from, amount);
    }
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        super._update(from, to, value);
    }
    
    function totalSupplyInUgx() external view returns (uint256) {
        return totalSupply() / 10**decimals();
    }
    
    function balanceInUgx(address account) external view returns (uint256) {
        return balanceOf(account) / 10**decimals();
    }
    
    // Meta-transaction overrides
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