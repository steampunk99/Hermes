// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title UGDx Token
 * @dev Implementation of the Uganda Digital Shilling Token
 * @custom:dev-run-script ./scripts/deploy_token.js
 */
contract UGDxToken is ERC20, Pausable, Ownable {
    // Events for tracking token minting and burning
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);

    /**
     * @dev Sets the values for {name} and {symbol}.
     * All two of these values are immutable: they can only be set once during
     * construction.
     */
    constructor() ERC20("Uganda Digital Shilling", "UGDx") {
        // Initial setup complete with name and symbol
    }

    /**
     * @dev Creates `amount` tokens and assigns them to `to`, increasing
     * the total supply.
     * Requirements:
     * - `to` cannot be the zero address
     * - only owner can mint new tokens
     * - contract must not be paused
     * @param to The address that will receive the minted tokens
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) external onlyOwner whenNotPaused {
        require(to != address(0), "UGDx: Cannot mint to zero address");
        require(amount > 0, "UGDx: Amount must be positive");
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }

    /**
     * @dev Destroys `amount` tokens from the caller's account, reducing the
     * total supply.
     * Requirements:
     * - caller must have at least `amount` tokens
     * - contract must not be paused
     * @param amount The amount of tokens to burn
     */
    function burn(uint256 amount) external whenNotPaused {
        require(amount > 0, "UGDx: Amount must be positive");
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

    /**
     * @dev Pauses all token transfers.
     * Requirements:
     * - caller must be the contract owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpauses all token transfers.
     * Requirements:
     * - caller must be the contract owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Hook that is called before any transfer of tokens.
     * Requirements:
     * - contract must not be paused
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override whenNotPaused {
        super._beforeTokenTransfer(from, to, amount);
    }
}
