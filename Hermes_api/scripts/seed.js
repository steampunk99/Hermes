// Updated seed script aligned with enum-based Role model
// ----------------------------------------------
const { PrismaClient, Role } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { ethers } = require('ethers');
const { encryptPrivateKey } = require('../src/utils/encryption');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database using enum roles ...');

  const usersData = [
    {
      phone: '256700000000',
      email: 'admin@hermes.io',
      password: 'changeme',
      role: Role.HYPERADMIN,
      kycVerified: true,
    },
    {
      phone: '256710000000',
      email: 'zeus@hermes.io',
      password: 'advanced123',
      role: Role.ADVANCED,
      kycVerified: true,
    },
    {
      phone: '256720000000',
      email: 'lou@hermes.io',
      password: 'password123',
      role: Role.USER,
      kycVerified: true,
    },
  ];

  const saltRounds = 10;
  for (const u of usersData) {
    const passwordHash = await bcrypt.hash(u.password, saltRounds);
    const wallet = ethers.Wallet.createRandom(); // Create wallet address like in auth registration
    const encryptedPrivateKey = encryptPrivateKey(wallet.privateKey);
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        phone: u.phone,
        email: u.email,
        passwordHash,
        kycVerified: u.kycVerified,
        role: u.role,
        walletAddress: wallet.address, // Add wallet address
        sensei: encryptedPrivateKey,
      },
    });
  }

  console.log('✅ Database seeded successfully');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
