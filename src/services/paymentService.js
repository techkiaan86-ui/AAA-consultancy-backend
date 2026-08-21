const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { paymentDripQueue } = require('../queues/queueSetup');
const packagesConfig = require('../config/packages');

// Secure Payment State Machine Transition
const processPaymentEvent = async (event) => {
  try {
    const session = event.data.object;
    // Assuming we pass paymentId in client_reference_id or metadata
    const paymentId = session.client_reference_id || session.metadata?.paymentId;
    const transactionId = session.id;

    if (!paymentId) {
      console.warn('Payment Event received without paymentId reference', event.id);
      return;
    }

    // Use Prisma transaction for atomicity and idempotency check
    await prisma.$transaction(async (tx) => {
      // Find the payment record
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { client: true, applicationCycle: true }
      });

      if (!payment) {
        const lead = await tx.lead.findUnique({ where: { id: paymentId } });
        if (lead) {
          let existingQual = lead.qualificationData || {};
          if (typeof existingQual !== 'object') existingQual = {};
          const totalPaidAmt = session.amount_total ? session.amount_total / 100 : (existingQual.estimatedPrice || lead.wordCount ? existingQual.estimatedPrice : 0);

          await tx.lead.update({
            where: { id: paymentId },
            data: {
              status: 'Payment Completed',
              qualificationData: {
                ...existingQual,
                paymentStatus: 'Paid',
                paidAt: new Date().toISOString(),
                stripeSessionId: transactionId,
                totalPaid: totalPaidAmt
              }
            }
          });
          console.log(`[Payment Event] Updated Lead ${paymentId} status to Payment Completed.`);

          // Send WhatsApp and Email receipt to Lead
          try {
            const { sendPaymentSuccessWhatsApp } = require('./whatsappService');
            await sendPaymentSuccessWhatsApp({
              lead,
              phone: lead.phone,
              paymentId: lead.id,
              amount: totalPaidAmt,
              serviceType: lead.serviceType,
              transactionId
            });
            console.log(`[Payment Event] Dispatched WhatsApp receipt to Lead ${lead.phone}`);
          } catch (waErr) {
            console.error('[Payment Event Lead WA Error]:', waErr.message);
          }

          try {
            const { sendPaymentSuccessEmail } = require('./emailService');
            if (lead.email) {
              await sendPaymentSuccessEmail({
                to: lead.email,
                clientName: `${lead.firstName} ${lead.lastName}`.trim(),
                customerId: `LEAD-${lead.id.substring(0, 6)}`,
                serviceType: lead.serviceType,
                amount: totalPaidAmt
              });
              console.log(`[Payment Event] Dispatched confirmation email to Lead ${lead.email}`);
            }
          } catch (emailErr) {
            console.error('[Payment Event Lead Email Error]:', emailErr.message);
          }

          return;
        }
        throw new Error(`Payment record ${paymentId} not found`);
      }

      // Idempotency: Ignore if this transactionId has already been successfully processed
      if (payment.transactionId === transactionId && payment.status === 'Paid') {
        console.log(`Payment event ${event.id} already processed. Skipping.`);
        return;
      }

      // Define state transition logic
      if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
        // Enforce deterministic transition rules (Only Pending -> Paid)
        if (payment.status !== 'Pending') {
          throw new Error(`Invalid state transition: Cannot transition from ${payment.status} to Paid`);
        }

        const totalPaid = session.amount_total ? session.amount_total / 100 : payment.amount;

        const clientWithAgent = await tx.client.findUnique({
          where: { id: payment.clientId },
          include: { assignedTo: true }
        });
        const snapshotRate = (clientWithAgent && clientWithAgent.assignedTo) 
          ? (clientWithAgent.assignedTo.commissionRate || 0) 
          : 0;

        const isPackagePayment = session.metadata?.type === 'package_payment';
        const assessmentPaymentId = session.metadata?.assessmentPaymentId || (payment.invoiceSnapshot ? payment.invoiceSnapshot.assessmentPaymentId : null);

        // If it's a package payment that used assessment credit, atomically mark it as used and clear reservation
        if (isPackagePayment && assessmentPaymentId) {
          const assessmentPayment = await tx.payment.findUnique({
            where: { id: assessmentPaymentId }
          });
          if (!assessmentPayment || assessmentPayment.status !== 'Paid' || assessmentPayment.assessmentCreditUsed) {
            throw new Error('Option A credit is no longer eligible or has already been used.');
          }

          await tx.payment.update({
            where: { id: assessmentPaymentId },
            data: {
              assessmentCreditUsed: true,
              creditReservedForPaymentId: null,
              creditReservedUntil: null
            }
          });
          console.log(`[Stripe Webhook] Marked Assessment Credit ${assessmentPaymentId} as USED.`);
        }

        // Set paidAt to Stripe session created time or Date.now()
        const paidAtDate = session.created ? new Date(session.created * 1000) : new Date();

        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: 'Paid',
            transactionId: transactionId,
            paymentMethod: 'Stripe',
            totalPaid: totalPaid,
            commissionRate: snapshotRate,
            paidAt: paidAtDate
          }
        });

        // Atomic Coupon Consumption (Globally Single-Use Enforcement)
        const couponCodeToConsume = session.metadata?.couponCode || payment.discountCode;
        if (couponCodeToConsume) {
          const cleanCouponCode = couponCodeToConsume.trim().toUpperCase();
          const couponConsumed = await tx.discountCode.updateMany({
            where: {
              code: cleanCouponCode,
              isUsed: false,
              expiryDate: { gte: new Date() }
            },
            data: {
              isUsed: true,
              usedAt: paidAtDate,
              usedByClientId: payment.clientId,
              usedInPaymentId: payment.id
            }
          });
          if (couponConsumed.count > 0) {
            console.log(`[Stripe Webhook] Atomically marked coupon "${cleanCouponCode}" as USED by client ${payment.clientId} in payment ${payment.id}.`);
          } else {
            console.warn(`[Stripe Webhook Warning] Coupon "${cleanCouponCode}" was not updated (may have been consumed by a concurrent process or expired prior to completion).`);
          }
        }

        // Trigger cascade state changes: If application exists, move to Active State
        if (payment.applicationId) {
          await tx.applicationCycle.update({
            where: { id: payment.applicationId },
            data: { status: 'Payment Received - Pending Docs' }
          });

          // Immutable Audit Log
          await tx.auditLog.create({
            data: {
              applicationId: payment.applicationId,
              actorId: 'System-StripeWebhook',
              action: 'PAYMENT_RECEIVED',
              newState: { status: 'Payment Received - Pending Docs' }
            }
          });
        }

        // Also update Client status and package details
        if (payment.client) {
          const isTranslation = (payment.client.serviceType || '').includes('Translation') || (payment.client.serviceId || '').includes('translation');
          const packageId = session.metadata?.packageId;
          const isNoShowAssessment = session.metadata?.type === 'no_show_case_assessment' || packageId === 'option_a' || packageId === 'Option A';
          const additionalApplicantsCount = session.metadata?.additionalApplicants ? parseInt(session.metadata.additionalApplicants, 10) : (payment.additionalApplicants || 0);

          const updatedClient = await tx.client.update({
            where: { id: payment.clientId },
            data: {
              documentUploadAllowed: true, // Allow document upload when Option A or full package is paid
              packageId: packageId || undefined,
              additionalApplicants: isNoShowAssessment ? 0 : additionalApplicantsCount,
              status: isNoShowAssessment 
                ? 'Partially Paid' 
                : (isTranslation ? 'Under Process' : 'Payment Completed'),
              visaStatus: isNoShowAssessment
                ? 'Not Started'
                : (isTranslation ? 'Under Process' : 'Document Preparation')
            }
          });

          // Update associated Lead status to 'Under Process' / 'Payment Received' if it exists
          let clientLead = null;
          if (!isNoShowAssessment) {
            clientLead = await tx.lead.findFirst({
              where: { clientId: payment.clientId }
            });
            if (clientLead) {
              await tx.lead.update({
                where: { id: clientLead.id },
                data: { status: isTranslation ? 'Under Process' : 'Payment Received' }
              });
              console.log(`[Stripe Webhook] Updated associated Lead ${clientLead.id} status to ${isTranslation ? 'Under Process' : 'Payment Received'}.`);
            }
          }

          // Send Checklist Email only if they paid for full package
          if (!isNoShowAssessment && !isTranslation) {
            try {
              const { sendVisaChecklist } = require('./emailService');
              const targetEmail = updatedClient.email || clientLead?.email;
              if (targetEmail) {
                await sendVisaChecklist(targetEmail, `${updatedClient.firstName} ${updatedClient.lastName}`, updatedClient.serviceType);
                console.log(`[Auto-Checklist Webhook] Sent checklist to client ${targetEmail} for ${updatedClient.serviceType}`);
              }
            } catch (emailErr) {
              console.error('[Auto-Checklist Webhook] Failed to send checklist email:', emailErr.message);
            }
          }

          // Auto-Sync Official Zoho Invoice & Mark as PAID upon Payment Completion
          let zohoInvoiceUrl = null;
          let zohoInvoiceId = null;
          try {
            const zohoInvoiceService = require('./zohoInvoiceService');
            const existingZohoId = updatedClient.zohoInvoiceId || payment?.gatewayId || (payment?.invoiceSnapshot && payment.invoiceSnapshot.zohoInvoiceId);
            
            if (existingZohoId) {
              console.log(`[Auto-Zoho Payment Webhook] Marking existing Zoho Invoice ${existingZohoId} as PAID...`);
              await zohoInvoiceService.markZohoInvoiceAsPaid({
                invoiceId: existingZohoId,
                amount: totalPaid,
                email: updatedClient.email || clientLead?.email,
                name: `${updatedClient.firstName} ${updatedClient.lastName}`.trim(),
                phone: updatedClient.phone || clientLead?.phone
              });
              zohoInvoiceId = existingZohoId;
              zohoInvoiceUrl = updatedClient.zohoInvoiceUrl || null;
            } else {
              const zohoRes = await zohoInvoiceService.createZohoInvoice({
                client: updatedClient,
                amount: totalPaid,
                netAmount: totalPaid,
                serviceType: updatedClient.serviceType || packageId || 'Spain Visa Service',
                isPaid: true
              });
              if (zohoRes && (zohoRes.invoiceUrl || zohoRes.paymentUrl)) {
                zohoInvoiceUrl = zohoRes.invoiceUrl || zohoRes.paymentUrl;
                zohoInvoiceId = zohoRes.invoiceId;
                console.log(`[Auto-Zoho Payment Webhook] Created & Paid Zoho Invoice ${zohoRes.invoiceNumber}. URL: ${zohoInvoiceUrl}`);
              }
            }
          } catch (zohoErr) {
            console.error('[Auto-Zoho Payment Webhook] Failed to sync Zoho Invoice payment:', zohoErr.message);
          }

          const targetPhone = updatedClient.phone || clientLead?.phone;
          const targetEmail = updatedClient.email || clientLead?.email;

          // Send Automated Payment Receipt & Credentials WhatsApp Message
          try {
            const { sendPaymentSuccessWhatsApp } = require('./whatsappService');
            await sendPaymentSuccessWhatsApp({
              client: updatedClient,
              lead: clientLead,
              phone: targetPhone,
              paymentId: payment.id,
              amount: totalPaid,
              serviceType: updatedClient.serviceType,
              generatedPassword: session.metadata?.tempPassword || null,
              zohoInvoiceUrl,
              invoiceId: zohoInvoiceId
            });
            console.log(`[Auto-WhatsApp Payment Webhook] Sent payment success & portal credentials to ${targetPhone}`);
          } catch (waErr) {
            console.error('[Auto-WhatsApp Payment Webhook] Failed to send WhatsApp notification:', waErr.message);
          }

          // Send Payment Confirmation Email
          try {
            const { sendPaymentSuccessEmail } = require('./emailService');
            const customerId = updatedClient.clientCode || `CID-${12000 + parseInt(updatedClient.id.replace(/\D/g, '').slice(-3) || '1')}`;
            if (targetEmail) {
              await sendPaymentSuccessEmail({
                to: targetEmail,
                clientName: `${updatedClient.firstName} ${updatedClient.lastName}`,
                customerId: customerId,
                serviceType: updatedClient.serviceType,
                amount: totalPaid,
                tempPassword: session.metadata?.tempPassword || null,
                zohoInvoiceUrl
              });
              console.log(`[Auto-Email Payment Webhook] Sent payment confirmation email to client ${targetEmail}`);
            }
          } catch (emailConfErr) {
            console.error('[Auto-Email Payment Webhook] Failed to send payment confirmation email:', emailConfErr.message);
          }

          // Send package payment email if it is a package selection checkout
          if (isPackagePayment) {
            try {
              const { sendPackagePaymentConfirmationEmail } = require('./emailService');
              await sendPackagePaymentConfirmationEmail({
                clientId: updatedClient.id,
                paymentId: payment.id
              });
              console.log(`[Email Webhook] Sent package payment success email to client ${updatedClient.email}`);
            } catch (emailErr) {
              console.error('[Email Webhook] Failed to send package payment confirmation email:', emailErr.message);
            }
          }

          // Trigger 2: Post-Payment Immediate Google Review Request
          try {
            const { sendGoogleReviewRequestWhatsApp } = require('./whatsappService');
            await sendGoogleReviewRequestWhatsApp({
              phone: updatedClient.phone,
              clientName: `${updatedClient.firstName} ${updatedClient.lastName}`.trim(),
              clientId: updatedClient.id,
              triggerStage: 'POST_PAYMENT'
            });
          } catch (gReviewErr) {
            console.error('[Payment Webhook] Trigger 2 Google Review failed:', gReviewErr.message);
          }

          // Trigger 3: Schedule 3-Day Post-Payment Google Review Drip
          try {
            const { remindersQueue } = require('../queues/queueSetup');
            if (remindersQueue && remindersQueue.add) {
              await remindersQueue.add('google-review-request-drip', {
                clientId: updatedClient.id,
                triggerStage: 'POST_PAYMENT_3D'
              }, { delay: 3 * 24 * 60 * 60 * 1000 });
              console.log(`[Payment Webhook] Scheduled Trigger 3 (3-Day Post-Payment Google Review Drip) for client ${updatedClient.id}`);
            }
          } catch (qErr) {
            console.error('[Payment Webhook] Trigger 3 queue scheduling failed:', qErr.message);
          }
        }
        
        // Remove from payment drip queue if applicable (handled by queue removal logic usually)
        
      } else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
        // We do not change state from Pending, but we might enqueue a payment drip reminder
        await paymentDripQueue.add('payment-failed-reminder', {
          clientId: payment.clientId,
          paymentId: payment.id,
          amount: payment.amount
        });
      }
    });

  } catch (err) {
    console.error('Failed to process payment event:', err);
    throw err; // Allow BullMQ or caller to handle retry/dlq
  }
};

module.exports = {
  processPaymentEvent,
  createNoShowAssessmentPayment: async (clientId, consultationId) => {
    const client = await prisma.client.findUnique({
      where: { id: clientId }
    });

    if (!client) throw new Error(`Client ${clientId} not found`);

    // Check for existing No-Show payment for this client
    const existingPayment = await prisma.payment.findFirst({
      where: {
        clientId: client.id,
        paymentPurpose: 'NO_SHOW_ASSESSMENT',
        status: { in: ['Pending', 'Paid'] }
      }
    });

    if (existingPayment) {
      if (existingPayment.status === 'Paid') return null; // No duplicate payments needed
      if (existingPayment.status === 'Pending') return existingPayment; // Return existing
    }

    const packageConfig = packagesConfig['OPTION_A'];
    const basePrice = packageConfig.basePrice;
    const vatRate = packageConfig.vatRate;
    const vatAmount = parseFloat((basePrice * (vatRate / 100)).toFixed(2));
    const total = parseFloat((basePrice + vatAmount).toFixed(2));

    const invoiceSnapshot = {
      packageId: 'OPTION_A',
      packageName: packageConfig.name,
      basePrice,
      additionalApplicants: 0,
      additionalApplicantPrice: 0,
      additionalApplicantTotal: 0,
      packageTotal: basePrice,
      creditApplied: 0,
      assessmentPaymentId: null,
      subtotal: basePrice,
      vatRate,
      vatAmount,
      total,
      currency: 'EUR',
      paymentPurpose: 'NO_SHOW_ASSESSMENT',
      consultationId
    };

    // Create database payment entry
    const payment = await prisma.payment.create({
      data: {
        clientId: client.id,
        amount: total,
        status: 'Pending',
        paymentMethod: 'STRIPE',
        packageType: 'OPTION_A',
        paymentPurpose: 'NO_SHOW_ASSESSMENT',
        invoiceSnapshot,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      }
    });

    const stripeSecret = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
    const stripe = require('stripe')(stripeSecret);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const stripeAmount = Math.round(total * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: packageConfig.name,
            description: `No-Show Fee for Free Spain Visa Eligibility Assessment | Customer ID: ${client.clientCode || client.id}`,
          },
          unit_amount: stripeAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      consent_collection: {
        terms_of_service: 'required',
      },
      success_url: `${frontendUrl}/#/public/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/#/portal/login?paymentId=${payment.id}`,
      client_reference_id: payment.id,
      metadata: {
        clientId: client.id,
        paymentId: payment.id,
        packageId: 'OPTION_A',
        type: 'no_show_case_assessment',
        paymentPurpose: 'NO_SHOW_ASSESSMENT'
      }
    });

    // Update payment gateway ID
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayId: session.id }
    });

    return { payment: updatedPayment, url: session.url };
  },

  checkAndApplyDeduction: async (clientId, basePrice) => {
    // Find any paid case assessment payment in the last 14 days
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const paidAssessment = await prisma.payment.findFirst({
      where: {
        clientId: clientId,
        status: 'Paid',
        packageType: 'OPTION_A',
        assessmentCreditUsed: false,
        paidAt: {
          gte: fourteenDaysAgo
        }
      }
    });

    if (paidAssessment) {
      // Deduct €250 from basePrice
      const finalPrice = Math.max(0, basePrice - 250);
      return {
        deducted: true,
        price: finalPrice,
        creditApplied: 250
      };
    }

    return {
      deducted: false,
      price: basePrice,
      creditApplied: 0
    };
  },

  calculatePackageInvoice: async (clientId, packageId, additionalApplicants) => {
    let packageConfig = packagesConfig[packageId];
    
    if (!packageConfig) {
      // Try fetching from database for dynamic packages
      const dbPackage = await prisma.relocationPackage.findUnique({
        where: { code: packageId }
      });
      if (dbPackage) {
        packageConfig = {
          id: dbPackage.code,
          name: dbPackage.name,
          basePrice: dbPackage.price,
          additionalApplicantPrice: dbPackage.additionalApplicantPrice,
          isFixedPrice: dbPackage.isFixedPrice,
          vatRate: 5,
          refundable: true,
          refundPercent: 50,
          creditEligible: dbPackage.code !== 'OPTION_A' && dbPackage.code !== 'opt_a'
        };
      }
    }

    if (!packageConfig) {
      throw new Error(`Invalid package selected: ${packageId}`);
    }

    const count = parseInt(additionalApplicants, 10);
    if (isNaN(count) || count < 0) {
      throw new Error(`Invalid additional applicants count: ${additionalApplicants}`);
    }

    if (packageId === 'OPTION_A' && count !== 0) {
      throw new Error('Professional Case Assessment cannot have additional applicants');
    }

    const basePrice = packageConfig.basePrice;
    const additionalApplicantPrice = packageConfig.additionalApplicantPrice;
    const additionalApplicantTotal = packageConfig.isFixedPrice ? 0 : parseFloat((count * additionalApplicantPrice).toFixed(2));
    const packageTotal = parseFloat((basePrice + additionalApplicantTotal).toFixed(2));

    let creditApplied = 0;
    let assessmentPaymentId = null;

    const isNonOptionA = packageId !== 'OPTION_A' && packageId !== 'opt_a';

    if (packageConfig.creditEligible || isNonOptionA) {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const activeCredit = await prisma.payment.findFirst({
        where: {
          clientId: clientId,
          status: 'Paid',
          assessmentCreditUsed: false,
          paidAt: { gte: fourteenDaysAgo },
          OR: [
            { packageType: 'OPTION_A' },
            { amount: 250 },
            { amount: 262.5 }
          ],
          OR: [
            { creditReservedForPaymentId: null },
            { creditReservedUntil: { lt: new Date() } }
          ]
        }
      });

      if (activeCredit) {
        creditApplied = Number(activeCredit.amount) || 250.00;
        assessmentPaymentId = activeCredit.id;
      }
    }

    const subtotal = parseFloat((packageTotal - creditApplied).toFixed(2));
    const vatRate = packageConfig.vatRate; // 5%
    const vatAmount = parseFloat((subtotal * (vatRate / 100)).toFixed(2));
    const total = parseFloat((subtotal + vatAmount).toFixed(2));

    const invoiceSnapshot = {
      packageId,
      packageName: packageConfig.name,
      basePrice,
      additionalApplicants: count,
      additionalApplicantPrice,
      additionalApplicantTotal,
      packageTotal,
      creditApplied,
      assessmentPaymentId,
      subtotal,
      vatRate,
      vatAmount,
      total,
      currency: 'EUR'
    };

    return invoiceSnapshot;
  }
};
