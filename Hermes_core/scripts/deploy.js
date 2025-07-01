// scripts/deploy.js
const { ethers } = require("hardhat");

/**
 * Wait for a contract to be deployed.
 */
async function waitDeployment(contract) {
  if (typeof contract.waitForDeployment === "function") {
    // Ethers v6
    await contract.waitForDeployment();
  } else if (typeof contract.deployed === "function") {
    // Ethers v5
    await contract.deployed();
  } else if (contract.deployTransaction) {
    // Fallback
    await contract.deployTransaction.wait();
  }
}

/**
 * Read the deployed contract address (v6 uses `.target`, v5 uses `.address`).
 */
function getDeployedAddress(contract) {
  if (contract.target) return contract.target;
  if (contract.address) return contract.address;
  throw new Error("Cannot determine deployed address");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  //
  // 1) ERC2771Forwarder
  //
  const ForwarderCF = await ethers.getContractFactory("ERC2771Forwarder");
  const forwarder = await ForwarderCF.deploy("Hermes Forwarder");
  await waitDeployment(forwarder);
  const forwarderAddr = getDeployedAddress(forwarder);
  console.log("ERC2771Forwarder deployed to:", forwarderAddr);

  //
  // 2) UGDX Token
  //
  const UGDXCF = await ethers.getContractFactory("UGDX");
  const ugdx = await UGDXCF.deploy(deployer.address, forwarderAddr);
  await waitDeployment(ugdx);
  const ugdxAddr = getDeployedAddress(ugdx);
  console.log("UGDX token deployed to:", ugdxAddr);

  //
  // 3) Price Oracle - FIX: Add required constructor arguments
  //
  const OracleCF = await ethers.getContractFactory("UGDXPriceOracle");
  const initialRate = ethers.parseUnits("3700", 18); // 3700 UGX per USD with 18 decimals
  const oracle = await OracleCF.deploy(initialRate, deployer.address);
  await waitDeployment(oracle);
  const oracleAddr = getDeployedAddress(oracle);
  console.log("UGDXPriceOracle deployed to:", oracleAddr);

  //
  // 4) UGDXBridge (handles both 4-arg & 5-arg constructors)
  //
  const BridgeCF = await ethers.getContractFactory("UGDXBridge");
  const ctorSize = BridgeCF.interface.deploy.inputs.length;
  console.log("Bridge ctor inputs:",BridgeCF.interface.deploy.inputs.map(i => `${i.name}:${i.type}`));

  console.log(`UGDXBridge constructor expects ${ctorSize} args.`);

  const usdtTokenAddress = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"; // USDT on Polygon
  let bridge;
  if (ctorSize === 5) {
    bridge = await BridgeCF.deploy(
      ugdxAddr,
      usdtTokenAddress,
      deployer.address,
      forwarderAddr,
      oracleAddr
    );
  } else if (ctorSize === 4) {
    bridge = await BridgeCF.deploy(
      ugdxAddr,
      usdtTokenAddress,
      deployer.address,
      forwarderAddr
    );
  } else {
    throw new Error(`Unexpected constructor arity: ${ctorSize}`);
  }
  await waitDeployment(bridge);
  const bridgeAddr = getDeployedAddress(bridge);
  console.log("UGDXBridge deployed to:", bridgeAddr);

  //
  // 5) Transfer UGDX ownership to Bridge
  //
  console.log("Transferring UGDX ownership to Bridge...");
  const tx = await ugdx.transferOwnership(bridgeAddr);
  await tx.wait();
  console.log("UGDX owner is now:", await ugdx.owner());

  //
  // 6) Authorize deployer as Oracle updater (using correct function name)
  //
  try {
    console.log("Adding deployer as authorized oracle updater...");
    const t2 = await oracle.addOracleSource(deployer.address);
    await t2.wait();
    console.log("Authorized deployer as Oracle updater");
  } catch (error) {
    console.log("Could not add oracle updater:", error.message);
  }

  //
  // 7) Print deployment summary
  //
  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Forwarder: ${forwarderAddr}`);
  console.log(`UGDX Token: ${ugdxAddr}`);
  console.log(`Oracle: ${oracleAddr} (Initial rate: 3700 UGX/USD)`);
  console.log(`Bridge: ${bridgeAddr}`);
  console.log(`UGDX Owner: ${await ugdx.owner()}`);

  //
  // 8) Print .env entries
  //
  console.log("\n=== COPY THESE TO .env ===");
  console.log(`FORWARDER_CONTRACT_ADDRESS=${forwarderAddr}`);
  console.log(`UGDX_CONTRACT_ADDRESS=${ugdxAddr}`);
  console.log(`ORACLE_CONTRACT_ADDRESS=${oracleAddr}`);
  console.log(`BRIDGE_CONTRACT_ADDRESS=${bridgeAddr}`);
  console.log("==========================");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Deployment failed:", err);
    process.exit(1);
  });