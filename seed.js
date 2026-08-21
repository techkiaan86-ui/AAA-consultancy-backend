const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database with 6 roles...');
  
  const salt = await bcrypt.genSalt(10);
  const defaultPassword = await bcrypt.hash('password123', salt);

  const usersToCreate = [
    {
      fullName: 'John SuperAdmin',
      email: 'superadmin@aaaconsultancy.com',
      password: defaultPassword,
      role: 'super_admin'
    },
    {
      fullName: 'Sarah Admin',
      email: 'admin@aaaconsultancy.com',
      password: defaultPassword,
      role: 'admin'
    },
    {
      fullName: 'David Consultant',
      email: 'agent@aaaconsultancy.com',
      password: defaultPassword,
      role: 'consultant'
    },
    {
      fullName: 'Emily Finance',
      email: 'finance@aaaconsultancy.com',
      password: defaultPassword,
      role: 'finance'
    },
    {
      fullName: 'Mark Operations',
      email: 'operations@aaaconsultancy.com',
      password: defaultPassword,
      role: 'operations'
    },
    {
      fullName: 'Jessica Marketing',
      email: 'marketing@aaaconsultancy.com',
      password: defaultPassword,
      role: 'marketing'
    }
  ];

  for (const user of usersToCreate) {
    const exists = await prisma.user.findUnique({ where: { email: user.email } });
    if (!exists) {
      await prisma.user.create({ data: user });
      console.log(`Created user: ${user.email} with role: ${user.role}`);
    } else {
      await prisma.user.update({
        where: { email: user.email },
        data: { password: user.password, role: user.role }
      });
      console.log(`Updated user password & role for: ${user.email}`);
    }
  }

  console.log('Seeding mock clients...');
  const clientsToCreate = [
    {
      id: 'CL2001',
      firstName: 'Elena',
      lastName: 'Petrova',
      email: 'elena@aaaconsultancy.com',
      phone: '+971500000001',
      password: defaultPassword,
      isTemporaryPassword: false,
      status: 'Under Process',
      visaStatus: 'Under Process'
    },
    {
      id: 'CL2002',
      firstName: 'Chloe',
      lastName: 'Dupont',
      email: 'chloe@aaaconsultancy.com',
      phone: '+971500000002',
      password: defaultPassword,
      isTemporaryPassword: false,
      status: 'Under Process',
      visaStatus: 'Under Process'
    }
  ];

  for (const client of clientsToCreate) {
    const exists = await prisma.client.findUnique({ where: { id: client.id } });
    if (!exists) {
      await prisma.client.create({ data: client });
      console.log(`Created client: ${client.firstName} with ID: ${client.id}`);
    } else {
      await prisma.client.update({
        where: { id: client.id },
        data: { password: client.password, status: client.status, visaStatus: client.visaStatus }
      });
      console.log(`Updated client: ${client.id}`);
    }
  }

  // Update password for test client anant@gmail.com if present
  const anantClient = await prisma.client.findFirst({ where: { email: 'anant@gmail.com' } });
  if (anantClient) {
    await prisma.client.update({
      where: { id: anantClient.id },
      data: { password: defaultPassword, isTemporaryPassword: false }
    });
    console.log('Updated password for client anant@gmail.com to password123');
  }

  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
