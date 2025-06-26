const { ethers } = require("hardhat");


async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

 // 1. Deploy the Trusted Forwarder (ERC2771Forwarder)
  const ERC2771Forwarder = await ethers.getContractFactory("ERC2771Forwarder");
  const forwarder = await ERC2771Forwarder.deploy("Hermes Forwarder"); // Pass a name for EIP712
  await forwarder.waitForDeployment(); // Changed from deployed() to waitForDeployment()
  const forwarderAddress = await forwarder.getAddress(); // Get address explicitly
  console.log("ERC2771Forwarder deployed to:", forwarderAddress);

  // 2. Deploy the UGDX Token
  // The owner will be the bridge contract, but we need to set it after deployment
  const UGDX = await ethers.getContractFactory("UGDX");
  const ugdxToken = await UGDX.deploy(deployer.address, forwarderAddress); // Use explicit address
  await ugdxToken.waitForDeployment(); // Changed from deployed() to waitForDeployment()
  const ugdxTokenAddress = await ugdxToken.getAddress(); // Get address explicitly
  console.log("UGDX token deployed to:", ugdxTokenAddress);

  // 3. Deploy the UGDXBridge
  // We need the address of the USDT token on Polygon mainnet or a testnet
  // For this example, we'll use a placeholder address. 
 const usdtTokenAddress = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; 
  const UGDXBridge = await ethers.getContractFactory("UGDXBridge");
  const bridge = await UGDXBridge.deploy(
    ugdxTokenAddress, // Use explicit address
    usdtTokenAddress,
    deployer.address, // The deployer is the initial owner of the bridge
    forwarderAddress // Use explicit address
  );
  await bridge.waitForDeployment(); // Changed from deployed() to waitForDeployment()
  const bridgeAddress = await bridge.getAddress(); // Get address explicitly
  console.log("UGDXBridge deployed to:", bridgeAddress);

  // 4. Transfer Ownership of UGDX to the Bridge
  console.log("Transferring ownership of UGDX to the bridge...");
  const tx = await ugdxToken.transferOwnership(bridgeAddress); // Use explicit address
  await tx.wait();
  console.log("Ownership of UGDX transferred to:", await ugdxToken.owner());

  console.log("\nDeployment complete!");
  console.log("----------------------------------------------------\n");
  console.log(`export const UGDX_ADDRESS="${ugdxTokenAddress}"`)
  console.log(`export const BRIDGE_ADDRESS="${bridgeAddress}"`)
  console.log(`export const FORWARDER_ADDRESS="${forwarderAddress}"\n`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
