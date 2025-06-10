const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UGDx Token System", function () {
    let UGDxToken;
    let Exchange;
    let token;
    let exchange;
    let owner;
    let user1;
    let user2;
    const INITIAL_SUPPLY = ethers.utils.parseEther("1000000"); // 1M UGDx

    beforeEach(async function () {
        // Get signers
        [owner, user1, user2] = await ethers.getSigners();

        // Deploy UGDxToken
        UGDxToken = await ethers.getContractFactory("UGDxToken");
        token = await UGDxToken.deploy();
        await token.deployed();

        // Deploy Exchange
        Exchange = await ethers.getContractFactory("Exchange");
        exchange = await Exchange.deploy(token.address);
        await exchange.deployed();

        // Add initial liquidity
        await token.mint(exchange.address, INITIAL_SUPPLY);
    });

    describe("UGDxToken", function () {
        it("Should set the correct token name and symbol", async function () {
            expect(await token.name()).to.equal("Uganda Digital Shilling");
            expect(await token.symbol()).to.equal("UGDx");
        });

        it("Should allow owner to mint tokens", async function () {
            const mintAmount = ethers.utils.parseEther("100");
            await token.mint(user1.address, mintAmount);
            expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
        });

        it("Should prevent non-owners from minting", async function () {
            const mintAmount = ethers.utils.parseEther("100");
            await expect(
                token.connect(user1).mint(user1.address, mintAmount)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should allow users to burn their tokens", async function () {
            const mintAmount = ethers.utils.parseEther("100");
            const burnAmount = ethers.utils.parseEther("50");
            
            await token.mint(user1.address, mintAmount);
            await token.connect(user1).burn(burnAmount);
            
            expect(await token.balanceOf(user1.address)).to.equal(mintAmount.sub(burnAmount));
        });

        it("Should handle pausing correctly", async function () {
            const mintAmount = ethers.utils.parseEther("100");
            await token.mint(user1.address, mintAmount);
            
            await token.pause();
            await expect(
                token.connect(user1).transfer(user2.address, mintAmount)
            ).to.be.revertedWith("Pausable: paused");
            
            await token.unpause();
            await token.connect(user1).transfer(user2.address, mintAmount);
            expect(await token.balanceOf(user2.address)).to.equal(mintAmount);
        });
    });

    describe("Exchange", function () {
        it("Should allow ETH to UGDx swaps", async function () {
            const ethAmount = ethers.utils.parseEther("1");
            const expectedUGDx = ethAmount.mul(1000000); // Based on exchange rate

            await expect(
                exchange.connect(user1).swapETHForUGDx({ value: ethAmount })
            ).to.emit(exchange, "SwappedETHForUGDx")
             .withArgs(user1.address, ethAmount, expectedUGDx);

            expect(await token.balanceOf(user1.address)).to.equal(expectedUGDx);
        });

        it("Should allow UGDx to ETH swaps", async function () {
            // First get some UGDx
            const ethAmount = ethers.utils.parseEther("1");
            await exchange.connect(user1).swapETHForUGDx({ value: ethAmount });

            const ugdxAmount = ethAmount.mul(1000000);
            await token.connect(user1).approve(exchange.address, ugdxAmount);

            const initialETHBalance = await user1.getBalance();
            
            await expect(
                exchange.connect(user1).swapUGDxForETH(ugdxAmount)
            ).to.emit(exchange, "SwappedUGDxForETH")
             .withArgs(user1.address, ugdxAmount, ethAmount);

            expect(await user1.getBalance()).to.be.gt(initialETHBalance);
        });

        it("Should handle withdrawal requests", async function () {
            const ethAmount = ethers.utils.parseEther("1");
            await exchange.connect(user1).swapETHForUGDx({ value: ethAmount });

            const ugdxAmount = ethAmount.mul(1000000);
            
            await expect(
                exchange.connect(user1).requestWithdrawal(ugdxAmount)
            ).to.emit(exchange, "WithdrawalRequested")
             .withArgs(user1.address, ugdxAmount);

            expect(await token.balanceOf(user1.address)).to.equal(0);
        });

        it("Should handle pausing correctly", async function () {
            const ethAmount = ethers.utils.parseEther("1");
            
            await exchange.pause();
            await expect(
                exchange.connect(user1).swapETHForUGDx({ value: ethAmount })
            ).to.be.revertedWith("Pausable: paused");
            
            await exchange.unpause();
            await exchange.connect(user1).swapETHForUGDx({ value: ethAmount });
        });

        it("Should handle liquidity management correctly", async function () {
            const ethAmount = ethers.utils.parseEther("1");
            const ugdxAmount = ethAmount.mul(1000000);

            // Mint tokens to owner for liquidity
            await token.mint(owner.address, ugdxAmount);
            await token.approve(exchange.address, ugdxAmount);

            await expect(
                exchange.addLiquidity(ugdxAmount, { value: ethAmount })
            ).to.emit(exchange, "LiquidityAdded")
             .withArgs(ethAmount, ugdxAmount);

            await expect(
                exchange.removeLiquidity(ethAmount, ugdxAmount)
            ).to.emit(exchange, "LiquidityRemoved")
             .withArgs(ethAmount, ugdxAmount);
        });
    });
});
