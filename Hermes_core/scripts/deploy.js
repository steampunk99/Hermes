const hre = require("hardhat");

async function main() {
    // Deploy UGDxToken
    const UGDxToken = await hre.ethers.getContractFactory("UGDxToken");
    const token = await UGDxToken.deploy();
    await token.deployed();
    console.log("UGDxToken deployed to:", token.address);

    // Deploy Exchange
    const Exchange = await hre.ethers.getContractFactory("Exchange");
    const exchange = await Exchange.deploy(token.address);
    await exchange.deployed();
    console.log("Exchange deployed to:", exchange.address);

    // Add initial liquidity
    const initialSupply = hre.ethers.utils.parseEther("1000000"); // 1M UGDx
    await token.mint(exchange.address, initialSupply);
    console.log("Initial liquidity added:", initialSupply.toString(), "UGDx");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
