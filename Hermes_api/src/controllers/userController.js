    // src/controllers/userController.js
const { prisma, ugdxContract } = require('../config');

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
async getBalance (req, res, next) {
  try {
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true, ugxCredit: true, gasCredit: true }
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    // Fetch on-chain UGDX token balance using Ethers.js (if walletAddress is set)
    let ugdxBalance = 0;
    if (user.walletAddress) {
      try {
        const balanceBigInt = await ugdxContract.balanceOf(user.walletAddress);
        // Convert from Wei (assuming UGDX has 18 decimals) to a human-readable number
        ugdxBalance = parseFloat(ethers.utils.formatUnits(balanceBigInt, 18));
      } catch (chainErr) {
        // If on-chain call fails (e.g., invalid address or network error), log and keep balance as 0
        console.error("Error fetching on-chain balance:", chainErr);
      }
    }
    return res.json({
      ugdxBalance,
      ugxCredit: parseFloat(user.ugxCredit),
      gasCredit: parseFloat(user.gasCredit)
    });
  } catch (err) {
    next(err);
  }
};

}

module.exports = new UserController();