const { ethers } = require("hardhat");
require("@openzeppelin/contracts/metatx/MinimalForwarder.sol");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  // 1. Deploy the Trusted Forwarder (MinimalForwarder)
  const MinimalForwarder = await ethers.getContractFactory("MinimalForwarder");
  const forwarder = await MinimalForwarder.deploy();
  await forwarder.deployed();
  console.log("MinimalForwarder deployed to:", forwarder.address);

  // 2. Deploy the UGDX Token
  // The owner will be the bridge contract, but we need to set it after deployment
  const UGDX = await ethers.getContractFactory("UGDX");
  const ugdxToken = await UGDX.deploy(deployer.address, forwarder.address); // Temporarily ownable by deployer
  await ugdxToken.deployed();
  console.log("UGDX token deployed to:", ugdxToken.address);

  // 3. Deploy the UGDXBridge
  // We need the address of the USDT token on Polygon mainnet or a testnet
  // For this example, we'll use a placeholder address. 
  // Replace with the actual Polygon USDT address: 0xc2132D05D31c914a87C6611C10748AEb04B58e8F
  const usdtTokenAddress = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; 
  const UGDXBridge = await ethers.getContractFactory("UGDXBridge");
  const bridge = await UGDXBridge.deploy(
    ugdxToken.address,
    usdtTokenAddress,
    deployer.address, // The deployer is the initial owner of the bridge
    forwarder.address
  );
  await bridge.deployed();
  console.log("UGDXBridge deployed to:", bridge.address);

  // 4. Transfer Ownership of UGDX to the Bridge
  console.log("Transferring ownership of UGDX to the bridge...");
  const tx = await ugdxToken.transferOwnership(bridge.address);
  await tx.wait();
  console.log("Ownership of UGDX transferred to:", await ugdxToken.owner());

  console.log("\nDeployment complete!");
  console.log("----------------------------------------------------\n");
  console.log(`export const UGDX_ADDRESS="${ugdxToken.address}"`)
  console.log(`export const BRIDGE_ADDRESS="${bridge.address}"`)
  console.log(`export const FORWARDER_ADDRESS="${forwarder.address}"\n`)

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
