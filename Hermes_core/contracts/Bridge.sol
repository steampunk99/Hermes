// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "./Coin.sol";

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

    constructor(address _ugdxToken, address _usdtToken, address _initialOwner, address trustedForwarder) 
    Ownable(_initialOwner)
    ERC2771Context(trustedForwarder) {
        require(_ugdxToken != address(0), "Bridge: Invalid ugdx address");
        require(_usdtToken != address(0), "Bridge: Invalid usdt address");

        ugdxToken = UGDX(_ugdxToken);
        usdtToken = IERC20(_usdtToken);
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

        //transfer usdt from user to bridge
        usdtToken.safeTransferFrom(sender, address(this), usdtAmount);

        uint256 usdtAmountIn18Decimals = usdtAmount * 10**12;

        //calculate ugdx amount : usdt * UGX_per_usd_rate
        uint256 ugdxAmountBeforeFee = (usdtAmountIn18Decimals * ugxPerUSD) / 10**18;

        //calc and deduct fee
        uint256 feeAmount = (ugdxAmountBeforeFee * swapFeeBps) / 10000;
        uint256 ugdxAmountAfterFee = ugdxAmountBeforeFee - feeAmount;

        //update reserves
        totalUSDTReserves += usdtAmount;
        totalUGDXMinted += ugdxAmountAfterFee;

        //mint ugdx to user
        ugdxToken.mint(sender, ugdxAmountAfterFee);

        emit USDTSwappedForUGDX(
            sender, usdtAmount,
            ugdxAmountAfterFee, feeAmount, ugxPerUSD
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