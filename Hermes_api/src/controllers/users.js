    // src/controllers/userController.js
const { prisma, logger, ugdxContract, forwarderContract } = require('../config');
const { ethers } = require('ethers');

class UserController {


// GET /user/profile
async getProfile (req, res, next)  {
  try {
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, email: true, kycVerified: true, walletAddress: true, role: true, gasCredit: true, ugxCredit: true }
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ profile: user });
  } catch (err) {
    next(err);
  }
};

// GET /user/balance
  async getBalance(req, res, next) {
    try {
      const userId = req.user.userId;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletAddress: true, ugxCredit: true, gasCredit: true }
      });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      // Fetch on-chain UGDX token balance and forwarder nonce using Ethers.js (if walletAddress is set)
      let ugdxBalance = 0;
      let forwarderNonce = null;
      if (user.walletAddress) {
        try {
          const balanceBigInt = await ugdxContract.balanceOf(user.walletAddress);
          ugdxBalance = Number(balanceBigInt) / 1e18;
          forwarderNonce = await forwarderContract.nonces(user.walletAddress);
          logger.info(`[DEBUG] UGDX balance for ${user.walletAddress}: ${ugdxBalance} | Forwarder nonce: ${forwarderNonce}`);
        
          // Convert from Wei (assuming UGDX has 18 decimals) to a human-readable number
          ugdxBalance = parseFloat(ethers.formatEther(balanceBigInt));
        } catch (chainErr) {
          // If on-chain call fails, log error and default balance to 0
          logger.error(`[${new Date().toISOString().slice(11, 23)}] ❌ Error fetching on-chain balance for ${user.walletAddress}:`, chainErr);
        }
      }
      return res.json({
        ugdxBalance,
        ugxCredit: parseFloat(user.ugxCredit),
        gasCredit: parseFloat(user.gasCredit),
        forwarderNonce: forwarderNonce !== null ? Number(forwarderNonce) : null
      });
    } catch (err) {
      next(err);
    }
  };

  // PUT /user/wallet
  async updateWallet(req, res, next) {
    try {
      const userId = req.user.userId;
      const { walletAddress } = req.body;
      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "A valid wallet address is required." });
      }
      // Update the user's wallet address (for advanced users linking an external wallet)
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { walletAddress: walletAddress }
      });
      logger.info(`User ${userId} updated wallet address to ${walletAddress}`);
      return res.json({
        message: "Wallet address updated successfully.",
        walletAddress: updatedUser.walletAddress
      });
    } catch (err) {
      next(err);
    }
  };

}

module.exports = new UserController();