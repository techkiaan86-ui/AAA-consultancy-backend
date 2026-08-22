/**
 * deploy.js — Railway Safe Startup Script & Auto-Migration Enforcer
 *
 * Guarantees Phase 2 database schema columns & tables exist on production MySQL:
 *   - documents.checklistItemId
 *   - documents.version
 *   - documents.reviewedById
 *   - documents.reviewedAt
 *   - application_cycles phase 2 columns
 *   - resubmission_checklist_items table
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function columnExists(table, column) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name   = ?
         AND column_name  = ?`,
      table,
      column
    );
    return Number(rows[0].cnt) > 0;
  } catch (e) {
    return false;
  }
}

async function tableExists(table) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name   = ?`,
      table
    );
    return Number(rows[0].cnt) > 0;
  } catch (e) {
    return false;
  }
}

async function ensurePhase2Schema() {
  console.log('[Deploy] Checking database schema for Phase 2 columns & tables...');

  // 1. Ensure resubmission_checklist_items table exists
  const hasChecklistTable = await tableExists('resubmission_checklist_items');
  if (!hasChecklistTable) {
    console.log('[Deploy] Creating table `resubmission_checklist_items`...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`resubmission_checklist_items\` (
        \`id\` VARCHAR(191) NOT NULL,
        \`applicationId\` VARCHAR(191) NOT NULL,
        \`templateKey\` VARCHAR(191) NOT NULL,
        \`belongsTo\` VARCHAR(191) NOT NULL DEFAULT 'Main Applicant',
        \`category\` VARCHAR(191) NOT NULL,
        \`title\` VARCHAR(191) NOT NULL,
        \`isMandatory\` BOOLEAN NOT NULL DEFAULT true,
        \`dueDate\` DATETIME(3) NULL,
        \`clientInstructions\` TEXT NULL,
        \`status\` VARCHAR(191) NOT NULL DEFAULT 'MISSING',
        \`sourceDocumentId\` VARCHAR(191) NULL,
        \`activeDocumentId\` VARCHAR(191) NULL,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` DATETIME(3) NOT NULL,
        UNIQUE INDEX \`resubmission_checklist_items_activeDocumentId_key\`(\`activeDocumentId\`),
        INDEX \`resubmission_checklist_items_applicationId_idx\`(\`applicationId\`),
        INDEX \`resubmission_checklist_items_status_idx\`(\`status\`),
        INDEX \`resubmission_checklist_items_sourceDocumentId_idx\`(\`sourceDocumentId\`),
        UNIQUE INDEX \`rci_appId_tmplKey_belongsTo_key\`(\`applicationId\`, \`templateKey\`, \`belongsTo\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `);
    console.log('[Deploy] Table `resubmission_checklist_items` created successfully.');
  } else {
    console.log('[Deploy] Table `resubmission_checklist_items`: OK');
  }

  // 2. Ensure documents table columns exist
  const docCols = [
    { name: 'checklistItemId', sql: 'ALTER TABLE `documents` ADD COLUMN `checklistItemId` VARCHAR(191) NULL;' },
    { name: 'version',          sql: 'ALTER TABLE `documents` ADD COLUMN `version` INT NOT NULL DEFAULT 1;' },
    { name: 'reviewedById',     sql: 'ALTER TABLE `documents` ADD COLUMN `reviewedById` VARCHAR(191) NULL;' },
    { name: 'reviewedAt',       sql: 'ALTER TABLE `documents` ADD COLUMN `reviewedAt` DATETIME(3) NULL;' }
  ];

  for (const col of docCols) {
    const exists = await columnExists('documents', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`documents.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`documents.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`documents.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`documents.${col.name}\`: OK`);
    }
  }

  // 3. Ensure application_cycles table columns exist
  const cycleCols = [
    { name: 'submissionReference',  sql: 'ALTER TABLE `application_cycles` ADD COLUMN `submissionReference` VARCHAR(191) NULL;' },
    { name: 'submissionNotes',      sql: 'ALTER TABLE `application_cycles` ADD COLUMN `submissionNotes` TEXT NULL;' },
    { name: 'submissionReceiptUrl', sql: 'ALTER TABLE `application_cycles` ADD COLUMN `submissionReceiptUrl` VARCHAR(191) NULL;' },
    { name: 'submittedById',        sql: 'ALTER TABLE `application_cycles` ADD COLUMN `submittedById` VARCHAR(191) NULL;' },
    { name: 'submittedAt',          sql: 'ALTER TABLE `application_cycles` ADD COLUMN `submittedAt` DATETIME(3) NULL;' },
    { name: 'closureReason',        sql: 'ALTER TABLE `application_cycles` ADD COLUMN `closureReason` TEXT NULL;' },
    { name: 'closedById',           sql: 'ALTER TABLE `application_cycles` ADD COLUMN `closedById` VARCHAR(191) NULL;' },
    { name: 'closedAt',             sql: 'ALTER TABLE `application_cycles` ADD COLUMN `closedAt` DATETIME(3) NULL;' }
  ];

  for (const col of cycleCols) {
    const exists = await columnExists('application_cycles', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`application_cycles.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`application_cycles.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`application_cycles.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`application_cycles.${col.name}\`: OK`);
    }
  }

  // 4. Ensure consultations table columns exist
  const consultationCols = [
    { name: 'clientId', sql: 'ALTER TABLE `consultations` ADD COLUMN `clientId` VARCHAR(191) NULL;' }
  ];

  for (const col of consultationCols) {
    const exists = await columnExists('consultations', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`consultations.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`consultations.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`consultations.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`consultations.${col.name}\`: OK`);
    }
  }

  // 5. Ensure relocation_packages table isRefundable column exists
  const pkgCols = [
    { name: 'isRefundable', sql: 'ALTER TABLE `relocation_packages` ADD COLUMN `isRefundable` BOOLEAN NOT NULL DEFAULT false;' }
  ];

  for (const col of pkgCols) {
    const exists = await columnExists('relocation_packages', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`relocation_packages.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`relocation_packages.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`relocation_packages.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`relocation_packages.${col.name}\`: OK`);
    }
  }

  // 6. Ensure leads table columns exist
  const leadCols = [
    { name: 'caseComments', sql: 'ALTER TABLE `leads` ADD COLUMN `caseComments` JSON NULL;' }
  ];

  for (const col of leadCols) {
    const exists = await columnExists('leads', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`leads.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`leads.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`leads.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`leads.${col.name}\`: OK`);
    }
  }

  // 7. Ensure clients table passportNumber column exists
  const clientCols = [
    { name: 'passportNumber', sql: 'ALTER TABLE `clients` ADD COLUMN `passportNumber` VARCHAR(191) NULL;' }
  ];

  for (const col of clientCols) {
    const exists = await columnExists('clients', col.name);
    if (!exists) {
      console.log(`[Deploy] Adding column \`clients.${col.name}\`...`);
      try {
        await prisma.$executeRawUnsafe(col.sql);
        console.log(`[Deploy] Column \`clients.${col.name}\` added.`);
      } catch (err) {
        console.log(`[Deploy] Note on \`clients.${col.name}\`: ${err.message}`);
      }
    } else {
      console.log(`[Deploy] Column \`clients.${col.name}\`: OK`);
    }
  }
}

async function main() {
  console.log('[Deploy] ===== AAA Backend Startup =====');
  try {
    await ensurePhase2Schema();
    console.log('[Deploy] All database schema checks complete.');
  } catch (err) {
    console.error('[Deploy] Database check warning:', err.message);
  }
  console.log('[Deploy] Launching Express server (src/app)...');
  require('./src/app');
}

main();
