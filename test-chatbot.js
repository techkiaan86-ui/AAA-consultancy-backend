require('dotenv').config();
const { handleChatbotMessage } = require('./src/services/chatbotService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTest() {
  const testNumber = '+971599999999';
  const testName = 'TikTok Test Lead';

  console.log("--- Chatbot TikTok Flow Test ---");
  
  // Clean up any existing test lead for this number
  const cleanNumberPart = testNumber.replace('+', '');
  await prisma.lead.deleteMany({
    where: { phone: { contains: cleanNumberPart } }
  }).catch(() => {});

  console.log("1. Sending ad-click message from TikTok...");
  await handleChatbotMessage(testNumber, testName, 'I want to apply for Spain Visa from TikTok');

  console.log("\n2. Selecting Service Choice '2' (Digital Nomad Visa)...");
  await handleChatbotMessage(testNumber, testName, '2');

  console.log("\n3. Selecting Applicant count '1' (Main Only)...");
  await handleChatbotMessage(testNumber, testName, '1');

  // Verify Lead is created in DB with correct source
  console.log("\n4. Checking Database for Lead source...");
  const createdLead = await prisma.lead.findFirst({
    where: { phone: { contains: cleanNumberPart } }
  });

  if (createdLead) {
    console.log(`Lead Created Successfully:`);
    console.log(`- ID:     ${createdLead.id}`);
    console.log(`- Name:   ${createdLead.firstName} ${createdLead.lastName}`);
    console.log(`- Source: ${createdLead.source} (Expected: TikTok Ads)`);
    if (createdLead.source === 'TikTok Ads') {
      console.log('✅ TEST PASSED: TikTok source successfully tracked!');
    } else {
      console.log('❌ TEST FAILED: Incorrect lead source.');
    }
  } else {
    console.log('❌ TEST FAILED: Lead was not found in the database.');
  }
}

runTest().then(() => {
  console.log("\nChatbot TikTok test completed.");
  process.exit(0);
}).catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

