# UGDx Token and Exchange System

This project implements a token system for the Uganda Digital Shilling (UGDx) with an integrated exchange system for converting between ETH and UGDx tokens.

## Overview

The system consists of two main smart contracts:

1. **UGDxToken**: An ERC20 token representing the Uganda Digital Shilling
2. **Exchange**: A contract that handles conversions between ETH and UGDx

## Features

### UGDxToken
- ERC20 compliant token
- Minting capability (owner only)
- Burning functionality
- Pausable transfers
- Emergency controls

### Exchange
- ETH to UGDx conversion
- UGDx to ETH conversion
- Withdrawal requests
- Liquidity management
- Emergency pause functionality
- Reentrancy protection

## Technical Details

### Exchange Rate
- 1 ETH = 1,000,000 UGDx
- Fixed exchange rate implemented in the contract

### Security Features
- Ownable pattern for access control
- Pausable functionality for emergency situations
- ReentrancyGuard for swap functions
- Comprehensive input validation
- Event emission for all important actions

## Getting Started

### Prerequisites
- Node.js v14+ and npm
- Hardhat

### Installation

1. Install dependencies:
```bash
npm install
```

2. Compile contracts:
```bash
npx hardhat compile
```

3. Run tests:
```bash
npx hardhat test
```

### Deployment

1. Set up your environment variables:
   Create a `.env` file with:
   ```
   PRIVATE_KEY=your_private_key
   INFURA_PROJECT_ID=your_infura_project_id
   ```

2. Deploy to network:
```bash
npx hardhat run scripts/deploy.js --network <network-name>
```

## Usage

### For Users

1. **Converting ETH to UGDx**
   - Call `swapETHForUGDx()` with ETH value
   - Receive equivalent UGDx tokens

2. **Converting UGDx to ETH**
   - Approve Exchange contract to spend UGDx
   - Call `swapUGDxForETH(amount)`
   - Receive equivalent ETH

3. **Requesting Withdrawal**
   - Call `requestWithdrawal(amount)`
   - UGDx tokens are burned
   - Backend system processes the withdrawal

### For Administrators

1. **Managing Token Supply**
   - Mint new tokens using `mint()`
   - Monitor total supply

2. **Managing Exchange**
   - Add liquidity using `addLiquidity()`
   - Remove liquidity using `removeLiquidity()`
   - Pause/unpause system in emergencies

## Testing

The project includes comprehensive tests covering:
- Token functionality
- Exchange operations
- Security features
- Edge cases

Run tests with:
```bash
npx hardhat test
```

## Security Considerations

1. **Access Control**
   - Only owner can mint tokens
   - Only owner can manage liquidity
   - Only owner can pause/unpause

2. **Safety Checks**
   - Reentrancy protection
   - Balance validations
   - Address validations

3. **Emergency Controls**
   - Pause functionality
   - Liquidity management

## License

This project is licensed under the MIT License.
