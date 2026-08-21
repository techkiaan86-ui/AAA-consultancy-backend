-- AlterTable application_cycles
ALTER TABLE `application_cycles` 
    ADD COLUMN `submissionReference` VARCHAR(191) NULL,
    ADD COLUMN `submissionNotes` TEXT NULL,
    ADD COLUMN `submissionReceiptUrl` VARCHAR(191) NULL,
    ADD COLUMN `submittedById` VARCHAR(191) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    ADD COLUMN `closureReason` TEXT NULL,
    ADD COLUMN `closedById` VARCHAR(191) NULL,
    ADD COLUMN `closedAt` DATETIME(3) NULL;

-- CreateTable resubmission_checklist_items
CREATE TABLE `resubmission_checklist_items` (
    `id` VARCHAR(191) NOT NULL,
    `applicationId` VARCHAR(191) NOT NULL,
    `templateKey` VARCHAR(191) NOT NULL,
    `belongsTo` VARCHAR(191) NOT NULL DEFAULT 'Main Applicant',
    `category` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `isMandatory` BOOLEAN NOT NULL DEFAULT true,
    `dueDate` DATETIME(3) NULL,
    `clientInstructions` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'MISSING',
    `sourceDocumentId` VARCHAR(191) NULL,
    `activeDocumentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `resubmission_checklist_items_activeDocumentId_key`(`activeDocumentId`),
    INDEX `resubmission_checklist_items_applicationId_idx`(`applicationId`),
    INDEX `resubmission_checklist_items_status_idx`(`status`),
    INDEX `resubmission_checklist_items_sourceDocumentId_idx`(`sourceDocumentId`),
    UNIQUE INDEX `rci_appId_tmplKey_belongsTo_key`(`applicationId`, `templateKey`, `belongsTo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable documents
ALTER TABLE `documents` 
    ADD COLUMN `checklistItemId` VARCHAR(191) NULL,
    ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `reviewedById` VARCHAR(191) NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `documents_checklistItemId_version_key` ON `documents`(`checklistItemId`, `version`);

-- AddForeignKey
ALTER TABLE `application_cycles` ADD CONSTRAINT `application_cycles_submittedById_fkey` FOREIGN KEY (`submittedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `application_cycles` ADD CONSTRAINT `application_cycles_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resubmission_checklist_items` ADD CONSTRAINT `resubmission_checklist_items_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `application_cycles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `resubmission_checklist_items` ADD CONSTRAINT `resubmission_checklist_items_sourceDocumentId_fkey` FOREIGN KEY (`sourceDocumentId`) REFERENCES `documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `resubmission_checklist_items` ADD CONSTRAINT `resubmission_checklist_items_activeDocumentId_fkey` FOREIGN KEY (`activeDocumentId`) REFERENCES `documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_checklistItemId_fkey` FOREIGN KEY (`checklistItemId`) REFERENCES `resubmission_checklist_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `documents` ADD CONSTRAINT `documents_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
