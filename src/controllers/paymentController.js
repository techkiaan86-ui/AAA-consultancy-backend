const prisma = require('../config/db');
const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('your_stripe') 
  ? require('stripe')(process.env.STRIPE_SECRET_KEY) 
  : null;
const packagesConfig = require('../config/packages');
const paymentService = require('../services/paymentService');
const { validateIBAN, maskIBAN } = require('../utils/ibanValidator');

const getPayments = async (req, res) => {
  try {
    const isClient = req.user && req.user.role === 'client';
    const whereClause = isClient ? { clientId: req.user.id } : {};

    const payments = await prisma.payment.findMany({
      where: whereClause,
      select: {
        id: true,
        clientId: true,
        applicationId: true,
        amount: true,
        discount: true,
        totalPaid: true,
        commissionRate: true,
        status: true,
        refundStatus: true,
        refundEligibility: true,
        refundAmount: true,
        refundReason: true,
        refundRejectionReason: true,
        refundProcessedAt: true,
        refundProcessedBy: true,
        paymentMethod: true,
        transactionId: true,
        gatewayId: true,
        invoiceNumber: true,
        billingDate: true,
        dueDate: true,
        packageType: true,
        paymentPurpose: true,
        additionalApplicants: true,
        assessmentCreditUsed: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
        client: { select: { id: true, clientCode: true, firstName: true, lastName: true, assignedToId: true } }
      },
      orderBy: { billingDate: 'desc' }
    });
    
    const mapped = payments.map(p => ({
      ...p,
      invoiceNumber: p.invoiceNumber || (p.id ? `INV-2026-${p.id.replace(/-/g, '').slice(0, 8).toUpperCase()}` : 'INV-2026-00000000'),
      createdDate: p.billingDate,
      createdAt: p.billingDate,
      clientName: p.client ? `${p.client.firstName || ''} ${p.client.lastName || ''}`.trim() : 'Unknown',
      clientCode: p.client?.clientCode || null
    }));
    
    res.json(mapped);
  } catch (error) {
    console.error('[getPayments Error]:', error.message);
    res.status(500).json({ message: 'Server error fetching payments', error: error.message });
  }
};

const generatePaymentLink = async (req, res) => {
  try {
    const { clientId, packageId, amount, discount, gateway } = req.body; // gateway: 'stripe' | 'tabby' | 'bank'
    const finalAmount = Math.max(0, (Number(amount) || 0) - (Number(discount) || 0));

    const payment = await prisma.payment.create({
      data: {
        clientId,
        amount: Number(amount) || 0,
        discount: Number(discount) || 0,
        status: 'Pending',
        paymentMethod: gateway ? gateway.toUpperCase() : 'STRIPE',
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      }
    });

    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    let paymentUrl = `${frontendUrl}/#/portal/documents/${clientId}`;

    // 1. Stripe Live Checkout Session Generator
    if (stripe && (gateway === 'stripe' || !gateway)) {
      try {
        const clientRec = await prisma.client.findUnique({ where: { id: clientId }, select: { clientCode: true, firstName: true, lastName: true } }).catch(() => null);
        const cidDisplay = clientRec?.clientCode || clientId;
        const itemName = req.body.packageName || (req.body.serviceType ? `${req.body.serviceType} (Add-on Document)` : 'Spain Relocation Legal & Consulting Package');
        const itemDesc = `Payment for Customer: ${clientRec ? `${clientRec.firstName} ${clientRec.lastName}` : cidDisplay}${req.body.wordCount ? ` (${req.body.wordCount} words)` : ''}`;
        const isTranslation = (req.body.serviceType || '').toLowerCase().includes('translation') || itemName.toLowerCase().includes('translation');

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'eur',
              product_data: {
                name: itemName,
                description: itemDesc
              },
              unit_amount: Math.round(finalAmount * 100) // in cents
            },
            quantity: 1
          }],
          mode: 'payment',
          success_url: isTranslation 
            ? `${frontendUrl}/#/public/payment-success?session_id={CHECKOUT_SESSION_ID}&type=translation&clientId=${clientId}`
            : `${frontendUrl}/#/portal/login?payment=success&id=${payment.id}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendUrl}/#/portal/documents/${clientId}?cancelled=true`,
          client_reference_id: payment.id,
          metadata: {
            paymentId: payment.id,
            clientId,
            type: isTranslation ? 'translation' : 'package_payment'
          }
        });

        if (session && session.url) {
          paymentUrl = session.url;
          await prisma.payment.update({
            where: { id: payment.id },
            data: { gatewayId: session.id }
          });
        }
      } catch (stripeErr) {
        console.warn('[Stripe Session Engine] Could not create live Stripe session, falling back to Portal Checkout:', stripeErr.message);
      }
    }

    // 2. Tabby / Tamara Installment Checkout Session Generator
    if (gateway === 'tabby') {
      try {
        const clientObj = await prisma.client.findUnique({ where: { id: clientId } });
        const axios = require('axios');
        const tabbyRes = await axios.post('https://api.tabby.ai/api/v2/checkout', {
          payment: {
            amount: finalAmount.toFixed(2),
            currency: 'EUR',
            description: 'Spain Relocation Installment Package',
            buyer: {
              phone: clientObj?.phone || '+34600000000',
              email: clientObj?.email || 'client@example.com',
              name: clientObj ? `${clientObj.firstName} ${clientObj.lastName}` : 'Client'
            }
          },
          lang: 'en',
          merchant_code: process.env.TABBY_MERCHANT_CODE || 'AAA_CONSULTANCY',
          merchant_urls: {
            success: `${frontendUrl}/#/portal/login?payment=success&id=${payment.id}`,
            cancel: `${frontendUrl}/#/portal/documents/${clientId}?cancelled=true`,
            failure: `${frontendUrl}/#/portal/documents/${clientId}?failed=true`
          }
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.TABBY_SECRET_KEY || 'pk_test_mock'}`,
            'Content-Type': 'application/json'
          }
        });

        if (tabbyRes.data?.configuration?.available_products?.installments?.[0]?.web_url) {
          paymentUrl = tabbyRes.data.configuration.available_products.installments[0].web_url;
        }
      } catch (tabbyErr) {
        console.warn('[Tabby Session Engine] Could not create Tabby session:', tabbyErr.message);
      }
    }

    // 3. Zoho Invoice Generator
    if (gateway === 'zoho' || !gateway || gateway === 'stripe') {
      try {
        const clientObj = await prisma.client.findUnique({ where: { id: clientId } });
        const zohoInvoiceService = require('../services/zohoInvoiceService');
        const zohoRes = await zohoInvoiceService.createZohoInvoice({
          client: clientObj,
          amount: Number(amount) || 0,
          discount: Number(discount) || 0,
          netAmount: finalAmount,
          serviceType: clientObj?.serviceType,
          dueDate: payment.dueDate
        });

        if (zohoRes && zohoRes.paymentUrl) {
          paymentUrl = zohoRes.paymentUrl;
          await prisma.payment.update({
            where: { id: payment.id },
            data: { 
              gatewayId: zohoRes.invoiceId,
              invoiceNumber: zohoRes.invoiceNumber || `INV-2026-${payment.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`
            }
          });
        }
      } catch (zohoErr) {
        console.warn('[Zoho Invoice Engine] Could not create Zoho session:', zohoErr.message);
      }
    }

    // Auto-dispatch Email & WhatsApp Invoice notifications to client
    try {
      const clientObj = await prisma.client.findUnique({ where: { id: clientId } });
      if (clientObj) {
        const clientName = `${clientObj.firstName} ${clientObj.lastName}`.trim();
        const { sendInvoiceNotificationEmail } = require('../services/emailService');
        const { sendInvoiceWhatsApp } = require('../services/whatsappService');

        sendInvoiceNotificationEmail({
          to: clientObj.email,
          clientName,
          amount: Number(amount) || 0,
          discount: Number(discount) || 0,
          netAmount: finalAmount,
          serviceType: clientObj.serviceType,
          checkoutUrl: paymentUrl
        }).catch(err => console.error('[Auto-Invoice Email Error]:', err.message));

        sendInvoiceWhatsApp({
          client: clientObj,
          amount: Number(amount) || 0,
          discount: Number(discount) || 0,
          netAmount: finalAmount,
          serviceType: clientObj.serviceType,
          checkoutUrl: paymentUrl
        }).catch(err => console.error('[Auto-Invoice WA Error]:', err.message));
      }
    } catch (dispatchErr) {
      console.error('[Auto-Invoice Notifications Error]:', dispatchErr.message);
    }

    res.status(201).json({
      ...payment,
      paymentUrl
    });
  } catch (error) {
    console.error('Error generating payment link:', error);
    res.status(500).json({ message: 'Server error generating payment link' });
  }
};

const updatePaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentMethod, transactionId } = req.body;
    
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    let snapshotRate = 0;
    if (status === 'Paid') {
      const clientWithAgent = await prisma.client.findUnique({
        where: { id: payment.clientId },
        include: { assignedTo: true }
      });
      if (clientWithAgent && clientWithAgent.assignedTo) {
        snapshotRate = clientWithAgent.assignedTo.commissionRate || 0;
      }
    }
    
    const updatedPayment = await prisma.payment.update({
      where: { id },
      data: { 
        status, 
        paymentMethod, 
        transactionId,
        totalPaid: status === 'Paid' ? (payment.amount - (payment.discount || 0)) : payment.totalPaid,
        commissionRate: status === 'Paid' ? snapshotRate : undefined,
        paidAt: (status === 'Paid' && !payment.paidAt) ? new Date() : undefined
      }
    });
    
    // Auto-trigger WhatsApp notification & client status update when payment is Paid
    if (status === 'Paid') {
      try {
        const clientObj = await prisma.client.findUnique({ where: { id: payment.clientId } });
        if (clientObj) {
          // 1. Update client status to Document Preparation & allow document upload
          await prisma.client.update({
            where: { id: clientObj.id },
            data: { status: 'Document Preparation', documentUploadAllowed: true }
          });

          // 2. Generate / Fetch official Zoho Tax Invoice URL
          let zohoInvoiceUrl = null;
          try {
            const zohoInvoiceService = require('../services/zohoInvoiceService');
            const zohoRes = await zohoInvoiceService.createZohoInvoice({
              client: clientObj,
              amount: Number(payment.amount) || 0,
              discount: Number(payment.discount) || 0,
              netAmount: updatedPayment.totalPaid || (payment.amount - (payment.discount || 0)),
              serviceType: clientObj.serviceType,
              dueDate: payment.dueDate
            });
            if (zohoRes && zohoRes.invoiceUrl) {
              zohoInvoiceUrl = zohoRes.invoiceUrl;
              if (zohoRes.invoiceNumber) {
                await prisma.payment.update({
                  where: { id: payment.id },
                  data: { invoiceNumber: zohoRes.invoiceNumber, gatewayId: zohoRes.invoiceId || undefined }
                }).catch(() => null);
              }
            }
          } catch (zohoErr) {
            console.warn('[Zoho Invoice Engine] Warning:', zohoErr.message);
          }

          // 3. Dispatch WhatsApp payment receipt with Zoho Invoice URL
          if (clientObj.phone) {
            const { sendPaymentSuccessWhatsApp } = require('../services/whatsappService');
            sendPaymentSuccessWhatsApp({
              client: clientObj,
              paymentId: updatedPayment.id,
              amount: updatedPayment.totalPaid || (payment.amount - (payment.discount || 0)),
              serviceType: clientObj.serviceType,
              transactionId: transactionId || updatedPayment.transactionId,
              zohoInvoiceUrl: zohoInvoiceUrl
            }).catch(err => console.error('[BG-WA] Payment receipt WA failed:', err.message));
            console.log(`[Auto-WhatsApp Payment Receipt] Dispatched receipt with Zoho Invoice link to ${clientObj.phone}`);
          }

          // 4. Dispatch Email payment receipt & document checklist to client email
          if (clientObj.email) {
            const { sendVisaChecklist } = require('../services/emailService');
            const clientName = `${clientObj.firstName} ${clientObj.lastName}`.trim();
            const invoiceLink = zohoInvoiceUrl || `${process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app'}/#/portal/login?zoho_fallback=true`;
            sendVisaChecklist(clientObj.email, clientName, clientObj.serviceType, {
              clientCode: clientObj.clientCode,
              amount: updatedPayment.amount,
              packageName: updatedPayment.packageType || clientObj.serviceType,
              transactionId: updatedPayment.transactionId,
              dateStr: new Date(updatedPayment.updatedAt || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
              invoiceUrl: invoiceLink
            }).catch(err => console.error('[BG-Email] Visa checklist email failed:', err.message));
            console.log(`[Auto-Email Payment Receipt] Dispatched checklist email to ${clientObj.email}`);
          }
        }
      } catch (err) {
        console.error('[Auto-WhatsApp Payment Receipt] Error dispatching WhatsApp notification:', err.message);
      }
    }

    res.json(updatedPayment);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating payment' });
  }
};
const getRefundRequests = async (req, res) => {
  try {
    const whereClause = req.user.role === 'client' ? { clientId: req.user.id } : {};
    let refunds = [];
    try {
      refunds = await prisma.refundRequest.findMany({
        where: whereClause,
        include: { 
          client: { 
            select: { 
              id: true, 
              clientCode: true,
              firstName: true, 
              lastName: true, 
              email: true, 
              phone: true, 
              serviceType: true,
              payments: {
                where: { status: 'Paid' }
              }
            } 
          } 
        },
        orderBy: { createdAt: 'desc' }
      });
    } catch (prismaErr) {
      console.warn('[getRefundRequests Warning] Retrying query without relation due to orphan record:', prismaErr.message);
      const rawRefunds = await prisma.refundRequest.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' }
      });

      const clientIds = [...new Set(rawRefunds.map(r => r.clientId).filter(Boolean))];
      const clients = await prisma.client.findMany({
        where: { id: { in: clientIds } },
        select: { 
          id: true, 
          clientCode: true,
          firstName: true, 
          lastName: true, 
          email: true, 
          phone: true, 
          serviceType: true,
          payments: {
            where: { status: 'Paid' }
          }
        }
      });
      const clientMap = new Map(clients.map(c => [c.id, c]));
      refunds = rawRefunds.map(r => ({
        ...r,
        client: clientMap.get(r.clientId) || null
      }));
    }
    
    const mapped = refunds.map(r => {
      const clientPaidTotal = (r.client?.payments || []).reduce((sum, p) => sum + p.amount, 0);
      return {
        id: r.id,
        clientId: r.clientId,
        clientCode: r.client?.clientCode || (r.clientId ? (r.clientId.length > 10 ? `#${r.clientId.substring(0, 8)}` : r.clientId) : 'N/A'),
        clientName: r.client ? `${r.client.firstName} ${r.client.lastName}` : 'Unknown',
        clientEmail: r.client?.email || '',
        clientPhone: r.client?.phone || '',
        serviceType: r.client?.serviceType || 'Visa Package',
        totalPaidAmount: clientPaidTotal,
        amount: r.amount || 0,
        status: r.status || 'Pending Review',
        category: r.category,
        date: (() => {
          const d = new Date(r.createdAt);
          const day = String(d.getDate()).padStart(2, '0');
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const year = d.getFullYear();
          return `${day}/${month}/${year}`;
        })(),
        reason: r.reason,
        proofUrl: r.proofUrl || null,
        bankAccountName: r.bankAccountName || '',
        bankIban: r.bankIban || '',
        bankSwift: r.bankSwift || '',
        payoutMethod: r.payoutMethod || null,
        transactionRef: r.transactionRef || null,
        adminNotes: r.adminNotes || '',
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      };
    });
    
    res.json(mapped);
  } catch (error) {
    console.error('Error fetching refunds:', error);
    res.status(500).json({ message: 'Server error fetching refunds' });
  }
};

const createRefundRequest = async (req, res) => {
  try {
    const { clientId: bodyClientId, clientEmail: bodyClientEmail, category, reason, amount, proofUrl, bankAccountName, bankIban, bankSwift } = req.body;
    const targetClientId = bodyClientId || req.user?.id;

    if (!targetClientId) {
      return res.status(400).json({ success: false, message: 'Client ID is required' });
    }

    // Strict IBAN structural & checksum validation
    let normalizedIban = null;
    if (bankIban && typeof bankIban === 'string' && bankIban.trim().length > 0) {
      const ibanValidation = validateIBAN(bankIban);
      if (!ibanValidation.valid) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a valid IBAN for your refund.',
          error: ibanValidation.error
        });
      }
      normalizedIban = ibanValidation.normalizedIBAN;
    }

    let refundAmount = Number(amount) || 0;
    
    const refund = await prisma.refundRequest.create({
      data: {
        clientId: targetClientId,
        category,
        reason,
        amount: refundAmount,
        proofUrl: proofUrl || null,
        bankAccountName: bankAccountName || null,
        bankIban: normalizedIban || null,
        bankSwift: bankSwift || null,
        status: 'Pending Review'
      }
    });

    try {
      const creatorName = req.user?.fullName || req.user?.email || 'Client Self-Service';
      const creatorRole = req.user?.role || 'client';

      // Robust client lookup by ID, Email, or User Session
      let targetClient = null;
      if (targetClientId) {
        targetClient = await prisma.client.findUnique({ where: { id: targetClientId } }).catch(() => null);
      }
      if (!targetClient && bodyClientEmail) {
        targetClient = await prisma.client.findUnique({ where: { email: bodyClientEmail } }).catch(() => null);
      }
      if (!targetClient && req.user?.email) {
        targetClient = await prisma.client.findUnique({ where: { email: req.user.email } }).catch(() => null);
      }
      if (!targetClient && req.user?.id) {
        targetClient = await prisma.client.findUnique({ where: { id: req.user.id } }).catch(() => null);
      }

      const clientEmail = targetClient?.email || bodyClientEmail || req.user?.email;
      const clientName = targetClient
        ? `${targetClient.firstName} ${targetClient.lastName}`
        : (req.user?.fullName || req.user?.name || req.user?.email?.split('@')[0] || 'Valued Client');

      await prisma.auditLog.create({
        data: {
          action: `Refund Request Created by ${creatorRole.toUpperCase()} (${creatorName})`,
          actorName: creatorName,
          actorRole: creatorRole,
          description: `Refund Request #${refund.id.substring(0, 8)} created for ${clientName}. Category: ${category}, Amount: €${refundAmount}. Raised by: ${creatorName} (${creatorRole}).`
        }
      });

      // 1. Dual Email Notifications (Admin Notification & Client Receipt)
      const { sendEmail } = require('../services/emailService');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const crmRefundUrl = `${frontendUrl}/#/super_admin/finance`;
      const dateSubmittedFormatted = new Date().toLocaleDateString('en-GB');

      // Email 1: Send alert to client@aaabusinessconsultancy.com
      const adminEmailHtml = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <div style="text-align: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 20px;">
            <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
            <p style="color: #dc2626; font-weight: 800; margin: 4px 0 0; font-size: 14px;">🚨 ALERT: New Refund Claim Submitted</p>
          </div>
          <p style="font-size: 15px; color: #1e293b;">A new 100% Money-Back Guarantee refund claim has been submitted on the Client Portal.</p>
          <div style="background-color: #FAF6ED; border: 1px solid rgba(197,155,39,0.4); padding: 18px; border-radius: 8px; margin: 20px 0;">
            <h4 style="margin: 0 0 10px; color: #051A3B;">Claim Summary (#${refund.id.substring(0, 8)})</h4>
            <p style="margin: 5px 0;"><strong>Client Name:</strong> ${clientName}</p>
            <p style="margin: 5px 0;"><strong>Client Email:</strong> ${clientEmail || 'N/A'}</p>
            <p style="margin: 5px 0;"><strong>Date Submitted:</strong> ${new Date().toLocaleDateString('en-GB')}</p>
            ${refundAmount > 0 ? `<p style="margin: 5px 0;"><strong>Claimed Amount:</strong> <span style="color: #dc2626; font-weight: 800;">€${refundAmount.toLocaleString()}</span></p>` : `<p style="margin: 5px 0;"><strong>Amount Status:</strong> <span style="color: #d97706; font-weight: 800;">Pending Admin Audit & Approval</span></p>`}
            <p style="margin: 5px 0;"><strong>Reason/Statement:</strong> ${reason || 'N/A'}</p>
            ${proofUrl ? `<p style="margin: 5px 0;"><strong>Embassy Proof:</strong> <a href="${proofUrl}" target="_blank" style="color: #0284c7; font-weight: 700;">View Rejection Letter 📄</a></p>` : ''}
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${crmRefundUrl}" style="background-color: #051A3B; color: #E5C058; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Audit & Process Payout in CRM Refunds Hub 🏦
            </a>
          </div>
        </div>
      `;

      const clientEmailHtml = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <div style="text-align: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 20px;">
            <h2 style="color: #051A3B; margin: 0;">AAA Business Consultancy</h2>
            <p style="color: #C59B27; font-weight: 700; margin: 4px 0 0; font-size: 14px;">Official Guarantee Refund Claim Acknowledgment</p>
          </div>
          <p style="font-size: 15px;">Dear <strong>${clientName}</strong>,</p>
          <p>We have successfully received your refund claim request under our <strong>Spain Visa 100% Money-Back Guarantee Policy</strong>.</p>
          <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; padding: 18px; border-radius: 8px; margin: 20px 0;">
            <h4 style="margin: 0 0 10px; color: #051A3B;">Ticket Claim Details (#${refund.id.substring(0, 8)})</h4>
            <p style="margin: 5px 0;"><strong>Category:</strong> ${category}</p>
            <p style="margin: 5px 0;"><strong>Date Submitted:</strong> ${new Date().toLocaleDateString('en-GB')}</p>
            <p style="margin: 5px 0;"><strong>Refund Amount Status:</strong> <strong style="color: #d97706;">Pending Admin Audit & Approval</strong></p>
            <p style="margin: 5px 0;"><strong>Status:</strong> <span style="background-color: #FEF3C7; color: #92400E; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">Pending Review</span></p>
          </div>
          <p style="font-size: 14px; color: #475569;">Our audit team is reviewing your submitted embassy rejection documentation. You will be updated once your payout is audited and executed.</p>
        </div>
      `;

      console.log(`[Refund Email] Dispatching dual emails (Admin & Client: ${clientEmail}) for claim #${refund.id}`);
      
      await Promise.allSettled([
        sendEmail({
          to: 'client@aaabusinessconsultancy.com',
          subject: `🚨 Alert: New Refund Claim Submitted by ${clientName} (€${refundAmount})`,
          html: adminEmailHtml
        }).then(res => console.log(`[Refund Email] Admin email sent:`, res))
          .catch(err => console.error('[BG-Email] Admin refund alert email failed:', err.message)),

        clientEmail ? sendEmail({
          to: clientEmail,
          subject: `🛡️ Refund Claim Received (#${refund.id.substring(0, 8)}) - AAA Business Consultancy`,
          html: clientEmailHtml
        }).then(res => console.log(`[Refund Email] Client receipt email sent to ${clientEmail}:`, res))
          .catch(err => console.error('[BG-Email] Client refund receipt email failed:', err.message)) : Promise.resolve()
      ]);

      // 2. Create Internal CRM Notification in DB
      try {
        await prisma.notification.create({
          data: {
            userId: targetClientId,
            type: 'REFUND_CLAIM',
            title: '🛡️ New Refund Claim Registered',
            body: `Client ${clientName} submitted a 100% refund claim (€${refundAmount.toLocaleString()}). Audit required.`
          }
        });
      } catch (notifErr) {
        console.error('Failed to create internal CRM notification:', notifErr.message);
      }

    } catch (auditErr) {
      console.error('Failed to process refund creation notifications:', auditErr.message);
    }
    
    res.status(201).json(refund);
  } catch (error) {
    console.error('Error creating refund request:', error);
    res.status(500).json({ message: 'Server error creating refund request' });
  }
};

const updateRefundStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payoutMethod, transactionRef, adminNotes, amount } = req.body;
    
    const updateData = { status };
    if (payoutMethod) updateData.payoutMethod = payoutMethod;
    if (transactionRef) updateData.transactionRef = transactionRef;
    if (adminNotes !== undefined) updateData.adminNotes = adminNotes;
    if (amount !== undefined && !isNaN(Number(amount))) updateData.amount = Number(amount);

    const refund = await prisma.refundRequest.update({
      where: { id },
      data: updateData,
      include: { client: true }
    });

    // Create AuditLog entry for full audit history tracking
    try {
      const adminUser = req.user ? req.user.fullName || req.user.email : 'Super Admin';
      const clientName = refund.client ? `${refund.client.firstName} ${refund.client.lastName}` : 'Client';
      await prisma.auditLog.create({
        data: {
          action: `Refund Status Updated to '${status}' (${refund.payoutMethod || 'Direct'} - €${refund.amount.toLocaleString()} - Ref: ${refund.transactionRef || 'N/A'}) for ${clientName}`,
          performedBy: adminUser,
          details: `Refund Request #${refund.id.substring(0, 8)} updated by ${adminUser}. Client: ${clientName}, Category: ${refund.category}, Amount: €${refund.amount}. Admin Notes: ${adminNotes || 'None'}`
        }
      });
    } catch (auditErr) {
      console.error('Failed to record AuditLog entry:', auditErr.message);
    }

    // If status is updated to Processed, update payment records status to 'Refunded' and dispatch Automated Email Receipt
    if (status === 'Processed' && refund.client) {
      try {
        await prisma.payment.updateMany({
          where: { clientId: refund.clientId, status: { in: ['Paid', 'Payment Completed', 'Payment Received', 'COMPLETED', 'Paid Fees'] } },
          data: { status: 'Refunded' }
        });
      } catch (payErr) {
        console.error('Failed to update payment status to Refunded:', payErr);
      }

      // Fire-and-forget Email Receipt Dispatch
      const { sendEmail } = require('../services/emailService');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const portalUrl = `${frontendUrl}/#/portal/documents/${refund.clientId}`;

      const receiptHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #2d3748; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px; border-bottom: 2px solid #f1f5f9; padding-bottom: 16px;">
            <h2 style="color: #051A3B; margin: 0; font-size: 24px;">AAA Business Consultancy</h2>
            <p style="color: #C59B27; font-size: 14px; font-weight: 700; margin: 4px 0 0;">Official Refund Confirmation & Payment Receipt</p>
          </div>
          
          <p>Dear <strong>${refund.client.firstName} ${refund.client.lastName}</strong>,</p>
          <p>We are writing to confirm that your refund claim under our <strong>Spain Visa 100% Money-Back Guarantee Policy</strong> has been audited and successfully processed.</p>
          
          <div style="background-color: #FAF6ED; border: 1px solid rgba(197, 155, 39, 0.4); padding: 20px; margin: 20px 0; border-radius: 8px;">
            <h4 style="margin: 0 0 12px; color: #051A3B; font-size: 16px;">Receipt Summary (#${refund.id.substring(0, 8)})</h4>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Refund Category:</strong> ${refund.category}</p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Processed Amount:</strong> <span style="color: #dc2626; font-weight: 800; font-size: 18px;">€${refund.amount.toLocaleString()}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Payout Method:</strong> ${refund.payoutMethod || 'Direct Transfer'}</p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Transaction / UTR Ref:</strong> <code style="background-color: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${refund.transactionRef || 'N/A'}</code></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Processing Date:</strong> ${new Date().toLocaleDateString('en-GB')}</p>
          </div>

          <div style="text-align: center; margin: 28px 0;">
            <a href="${portalUrl}" style="background-color: #051A3B; color: #E5C058; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px; display: inline-block;">
              View & Download PDF Receipt in Portal
            </a>
          </div>

          <p style="font-size: 13px; color: #64748b; margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 12px; text-align: center;">
            This is an automated financial confirmation from AAA Business Consultancy LLC.
          </p>
        </div>
      `;

      sendEmail({
        to: refund.client.email,
        subject: `Refund Processed Successfully (€${refund.amount}) - AAA Visa`,
        html: receiptHtml
      }).catch(mailErr => console.error('[BG-Email] Refund receipt email failed:', mailErr.message));
    }
    
    res.json(refund);
  } catch (error) {
    console.error('Error updating refund status:', error);
    res.status(500).json({ message: 'Server error updating refund status' });
  }
};

const getCommissionRates = async (req, res) => {
  try {
    const agents = await prisma.user.findMany({
      where: { role: { in: ['admin', 'consultant', 'super_admin', 'operations', 'finance', 'marketing'] } },
      select: { id: true, commissionType: true, commissionRate: true }
    });
    
    const rates = agents.map(a => ({
      agentId: a.id,
      type: a.commissionType || '10%',
      value: a.commissionRate || 10
    }));
    
    res.json(rates);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching commission rates' });
  }
};

const updateCommissionRate = async (req, res) => {
  try {
    const { agentId, type, value } = req.body;
    
    // 1. Get the agent profile
    const agentObj = await prisma.user.findUnique({
      where: { id: agentId }
    });

    if (!agentObj) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    // 2. Calculate current revenue for this agent
    const agentClients = await prisma.client.findMany({
      where: { assignedToId: agentId },
      select: { id: true }
    });
    const clientIds = agentClients.map(c => c.id);
    const paidPayments = await prisma.payment.findMany({
      where: { clientId: { in: clientIds }, status: 'Paid' },
      select: { amount: true }
    });
    const totalRevenue = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // 3. Create Rate History Log
    await prisma.commissionRateHistory.create({
      data: {
        agentId,
        oldRate: agentObj.commissionRate || 0,
        newRate: Number(value),
        changedById: req.user.id,
        revenueAtChange: totalRevenue
      }
    });

    // 4. Update agent rate
    await prisma.user.update({
      where: { id: agentId },
      data: {
        commissionType: type,
        commissionRate: Number(value)
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating commission rate:', error);
    res.status(500).json({ message: 'Server error updating commission rate' });
  }
};

const getCommissionsReport = async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { status: 'Paid' },
      include: {
        client: {
          include: { assignedTo: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const report = payments.map(p => {
      const agent = p.client?.assignedTo;
      const rate = p.commissionRate !== null && p.commissionRate !== undefined 
        ? p.commissionRate 
        : (agent?.commissionRate || 0);
      const commissionEarned = p.amount * (rate / 100);
      
      // For now, assume commission is accrued (pending) unless agent has explicitly been paid
      // We are distributing agent.commissionPaid across their payments sequentially if needed, 
      // but a simpler approach is just to flag them all as pending unless we build payout logic.
      // The UI expects commissionEarned, commissionPending, commissionPaid per row.
      const commissionPaid = 0; 
      
      return {
        id: p.id,
        date: p.createdAt.toISOString().split('T')[0],
        paymentId: p.id.substring(0, 8),
        clientName: p.client ? `${p.client.firstName} ${p.client.lastName}` : 'Unknown',
        agentName: agent ? agent.fullName : 'Unassigned',
        agentId: agent?.id,
        amountPaid: p.amount,
        structure: agent?.commissionType || '10%',
        commissionEarned,
        commissionPaid,
        commissionPending: commissionEarned - commissionPaid
      };
    });
    
    res.json(report);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching commissions report' });
  }
};
const createStripeCheckoutSession = async (req, res) => {
  try {
    const { packageId, amount, discount, paymentMethod, clientId: bodyClientId } = req.body;
    let clientId = bodyClientId || req.user?.id;

    let clientRecord = null;
    if (clientId) {
      clientRecord = await prisma.client.findUnique({
        where: { id: clientId }
      });
    }

    if (!clientRecord && req.user?.email) {
      clientRecord = await prisma.client.findFirst({
        where: { email: req.user.email }
      });
    }

    if (!clientRecord && req.user?.id) {
      const userObj = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (userObj?.email) {
        clientRecord = await prisma.client.findFirst({
          where: { email: userObj.email }
        });
      }
    }

    if (!clientRecord) {
      return res.status(404).json({ success: false, message: 'Client profile not found. Please log in or contact support.' });
    }

    clientId = clientRecord.id;

    // Helper helper to get applicants count
    const getApplicantsCount = (countStr) => {
      if (!countStr || countStr === 'Main Only') return 1;
      const numericVal = parseInt(countStr, 10);
      if (!isNaN(numericVal) && String(numericVal) === countStr.trim()) {
        return numericVal;
      }
      const match = countStr.match(/Main\s*\+\s*(\d+)/i);
      if (match) {
        return 1 + parseInt(match[1], 10);
      }
      return 1;
    };

    // Server-side deduction verification to prevent price tampering
    let enforcedAmount = Number(amount) || 0;
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const paidAssessment = await prisma.payment.findFirst({
      where: {
        clientId,
        status: 'Paid',
        amount: 262.50, // €250 + 5% VAT
        createdAt: { gte: fourteenDaysAgo }
      }
    });

    if (paidAssessment && ['full_process', 'premium', 'relocation'].includes(packageId)) {
      const totalApplicants = getApplicantsCount(clientRecord.applicantsCount);
      const addApplicants = totalApplicants - 1;
      let baseExpected = 0;
      if (packageId === 'full_process') baseExpected = 3500 + (addApplicants * 500);
      else if (packageId === 'premium') baseExpected = 4750 + (addApplicants * 750);
      else if (packageId === 'relocation') baseExpected = 1750 + (addApplicants * 500);

      const expectedDeducted = Math.max(0, baseExpected - 250);
      if (enforcedAmount !== expectedDeducted) {
        console.warn(`[Payment Security] Price tampering detected. Client sent €${enforcedAmount}, expected €${expectedDeducted}. Enforcing correct price.`);
        enforcedAmount = expectedDeducted;
      }
    }

    // 1. Coupon Re-Validation & Server-side Price Engine
    let validatedCoupon = null;
    let discountPercent = 0;
    let discountAmount = 0;
    const baseAmount = enforcedAmount;

    const { couponCode } = req.body;
    if (couponCode && typeof couponCode === 'string' && couponCode.trim()) {
      const cleanCode = couponCode.trim().toUpperCase();
      const couponObj = await prisma.discountCode.findUnique({
        where: { code: cleanCode }
      });

      if (!couponObj) {
        return res.status(400).json({ success: false, message: 'Invalid coupon code.' });
      }
      if (couponObj.isUsed) {
        return res.status(400).json({ success: false, message: 'This coupon has already been used.' });
      }
      if (new Date() >= new Date(couponObj.expiryDate)) {
        return res.status(400).json({ success: false, message: 'This coupon has expired.' });
      }

      validatedCoupon = couponObj;
      discountPercent = couponObj.discountPercent || 0;
      discountAmount = Math.round((baseAmount * (discountPercent / 100)) * 100) / 100;
    }

    // Fetch company settings for VAT rate (default 5%)
    let vatRate = 5;
    try {
      const settings = await prisma.companySetting.findFirst();
      if (settings && typeof settings.vatRate === 'number') {
        vatRate = settings.vatRate;
      }
    } catch (sErr) {
      console.warn('[createStripeCheckoutSession] Settings lookup fallback to 5%:', sErr.message);
    }

    // Both VAT and Coupon are calculated directly on the Base Package Amount (baseAmount)
    const vatAmount = Math.round((baseAmount * (vatRate / 100)) * 100) / 100;
    const netAmount = Math.max(0, Math.round((baseAmount - discountAmount) * 100) / 100);
    const finalTotalPayable = Math.max(0, Math.round((baseAmount + vatAmount - discountAmount) * 100) / 100);

    // 2. Create a Pending payment record in the database first
    const payment = await prisma.payment.create({
      data: {
        clientId,
        amount: baseAmount,
        discount: discountAmount,
        discountCodeId: validatedCoupon?.id || null,
        discountCode: validatedCoupon?.code || null,
        discountPercent: discountPercent,
        invoiceSnapshot: {
          originalAmount: baseAmount,
          couponCode: validatedCoupon?.code || null,
          discountPercent: discountPercent,
          discountAmount: discountAmount,
          netAmount: netAmount,
          vatRate: vatRate,
          vatAmount: vatAmount,
          finalTotal: finalTotalPayable
        },
        status: 'Pending',
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      }
    });

    // 3. Handle Tabby Payment Method
    if (paymentMethod === 'tabby') {
      const tabbyService = require('../services/tabbyService');
      const sessionData = await tabbyService.createTabbyCheckoutSession({
        clientId,
        amount: finalTotalPayable, // include VAT & discount
        email: clientRecord.email,
        phone: clientRecord.phone,
        name: `${clientRecord.firstName} ${clientRecord.lastName}`
      });

      await prisma.payment.update({
        where: { id: payment.id },
        data: { 
          gatewayId: sessionData.sessionId,
          paymentMethod: 'Tabby'
        }
      });

      return res.status(200).json({
        success: true,
        url: sessionData.checkoutUrl
      });
    }

    // 4. Handle Tamara Payment Method
    if (paymentMethod === 'tamara') {
      const tamaraService = require('../services/tamaraService');
      const sessionData = await tamaraService.createTamaraCheckoutSession({
        clientId,
        amount: finalTotalPayable, // include VAT & discount
        email: clientRecord.email,
        phone: clientRecord.phone,
        name: `${clientRecord.firstName} ${clientRecord.lastName}`
      });

      await prisma.payment.update({
        where: { id: payment.id },
        data: { 
          gatewayId: sessionData.sessionId,
          paymentMethod: 'Tamara'
        }
      });

      return res.status(200).json({
        success: true,
        url: sessionData.checkoutUrl
      });
    }

    // 5. Build Stripe session parameters or fallback to mock
    if (!stripe) {
      console.warn('Stripe is not configured. Simulating successful checkout.');
      // Auto success in mock mode
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'Paid',
          paymentMethod: 'Mock Auto',
          totalPaid: finalTotalPayable,
          transactionId: `TXN_MOCK_${payment.id}`
        }
      });

      // Mark coupon as used if mock mode
      if (validatedCoupon) {
        await prisma.discountCode.update({
          where: { id: validatedCoupon.id },
          data: {
            isUsed: true,
            usedAt: new Date(),
            usedByClientId: clientId,
            usedInPaymentId: payment.id
          }
        }).catch(err => console.warn('[Mock Coupon] Error updating coupon:', err.message));
      }

      const client = await prisma.client.update({
        where: { id: clientId },
        data: {
          packageId: packageId || undefined,
          documentUploadAllowed: true,
          status: 'Payment Received',
          visaStatus: 'Document Preparation'
        }
      });

      // Send Checklist Email
      try {
        const { sendVisaChecklist } = require('../services/emailService');
        await sendVisaChecklist(client.email, `${client.firstName} ${client.lastName}`, client.serviceType);
        console.log(`[Auto-Checklist] Sent checklist to client ${client.email} for ${client.serviceType}`);
      } catch (emailErr) {
        console.error('[Auto-Checklist] Failed to send checklist email:', emailErr.message);
      }

      return res.status(200).json({
        success: true,
        isMock: true,
        url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${clientId}?session_id=mock_session_id&success=true`
      });
    }

    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    const clientRec = await prisma.client.findUnique({ where: { id: clientId }, select: { clientCode: true } }).catch(() => null);
    const customerIdDisplay = clientRec?.clientCode || clientId;

    let resolvedPackageName = 'Spain Relocation Package';
    if (packageId) {
      const pidStr = packageId.toString();
      if (packagesConfig[pidStr]?.name) {
        resolvedPackageName = packagesConfig[pidStr].name;
      } else if (pidStr.toLowerCase() === 'full_process' || pidStr.toLowerCase() === 'opt_b' || pidStr.toUpperCase() === 'OPTION_B') {
        resolvedPackageName = 'Full Processing Package — End-to-End Service';
      } else if (pidStr.toLowerCase() === 'premium' || pidStr.toLowerCase() === 'opt_d' || pidStr.toUpperCase() === 'OPTION_D') {
        resolvedPackageName = 'Premium Package — End-to-End + Relocation';
      } else if (pidStr.toLowerCase() === 'relocation' || pidStr.toLowerCase() === 'opt_c' || pidStr.toUpperCase() === 'OPTION_C') {
        resolvedPackageName = 'Administrative Relocation Package';
      } else if (pidStr.toUpperCase() === 'OPTION_A' || pidStr.toLowerCase() === 'opt_a') {
        resolvedPackageName = 'Professional Case Assessment';
      } else {
        try {
          const dbPkg = await prisma.package.findFirst({
            where: {
              OR: [
                { id: pidStr },
                { code: pidStr }
              ]
            }
          });
          if (dbPkg && dbPkg.name) {
            resolvedPackageName = dbPkg.name;
          }
        } catch (pErr) {
          // fallback to default
        }
      }
    }

    const packageNameStr = `${resolvedPackageName}${validatedCoupon ? ` (${validatedCoupon.code} - ${discountPercent}% OFF)` : ''}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: packageNameStr,
            description: `Certified Spain visa relocation & administrative services support for Customer ID: ${customerIdDisplay}`,
          },
          unit_amount: Math.max(50, Math.round(finalTotalPayable * 100)), // + 5% VAT included (min 50 cents)
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${frontendUrl}/#/portal/documents/${clientId}?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${frontendUrl}/#/portal/documents/${clientId}?cancel=true`,
      metadata: {
        clientId,
        paymentId: payment.id,
        packageId: String(packageId || 'custom'),
        amount: String(baseAmount),
        discount: String(discountAmount),
        couponCode: validatedCoupon?.code || '',
        couponId: validatedCoupon?.id || '',
        discountPercent: String(discountPercent),
        finalTotal: String(finalTotalPayable)
      }
    });

    // 6. Update payment record with the Stripe session ID (gatewayId)
    await prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayId: session.id }
    });

    res.status(200).json({
      success: true,
      url: session.url
    });

  } catch (error) {
    console.error('Error creating Stripe session:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error creating payment session' });
  }
};

const verifyStripeCheckoutSession = async (req, res) => {
  try {
    const { sessionId, paymentId, leadId } = req.body;
    let finalSessionId = sessionId;

    if (!finalSessionId && paymentId) {
      const paymentObj = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (paymentObj) {
        finalSessionId = paymentObj.gatewayId;
      }
    }

    if (!stripe) {
      // Mock payment mode verification
      if (leadId) {
        try {
          await prisma.lead.update({
            where: { id: leadId },
            data: { status: 'Payment Completed' }
          });
        } catch (e) {}
      }

      if (paymentId) {
        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (payment && payment.status !== 'Paid') {
          const finalPrice = payment.amount - (payment.discount || 0);
          
          let snapshotRate = 0;
          const clientWithAgent = await prisma.client.findUnique({
            where: { id: payment.clientId },
            include: { assignedTo: true }
          });
          if (clientWithAgent && clientWithAgent.assignedTo) {
            snapshotRate = clientWithAgent.assignedTo.commissionRate || 0;
          }

          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              status: 'Paid',
              transactionId: `mock-txn-${Date.now()}`,
              totalPaid: finalPrice,
              commissionRate: snapshotRate
            }
          });

          const isOptionA = payment.packageType === 'OPTION_A' || payment.packageType === 'option_a';
          const client = await prisma.client.update({
            where: { id: payment.clientId },
            data: {
              documentUploadAllowed: true,
              status: isOptionA ? 'Partially Paid' : 'Payment Completed',
              visaStatus: isOptionA ? 'Not Started' : 'Document Preparation'
            }
          });

          // Dispatch WhatsApp Payment Receipt & Zoho Invoice Link
          try {
            let zohoInvoiceUrl = null;
            try {
              const zohoInvoiceService = require('../services/zohoInvoiceService');
              const zohoRes = await zohoInvoiceService.createZohoInvoice({
                client,
                amount: Number(payment.amount) || 0,
                discount: Number(payment.discount) || 0,
                netAmount: finalPrice,
                serviceType: client.serviceType,
                dueDate: payment.dueDate
              });
              if (zohoRes && (zohoRes.invoiceUrl || zohoRes.paymentUrl)) {
                zohoInvoiceUrl = zohoRes.invoiceUrl || zohoRes.paymentUrl;
              }
            } catch (zohoErr) {
              console.warn('[Zoho Invoice Engine] Warning:', zohoErr.message);
            }

            if (client && client.phone) {
              const { sendPaymentSuccessWhatsApp } = require('../services/whatsappService');
              sendPaymentSuccessWhatsApp({
                client,
                paymentId: payment.id,
                amount: finalPrice,
                serviceType: client.serviceType,
                transactionId: `mock-txn-${Date.now()}`,
                zohoInvoiceUrl: zohoInvoiceUrl
              }).catch(err => console.error('[BG-WA] Payment receipt WA failed:', err.message));
              console.log(`[Auto-WhatsApp Payment Receipt] Dispatched mock checkout receipt to ${client.phone}`);
            }
          } catch (waErr) {
            console.error('[Auto-WhatsApp Payment Receipt] Mock checkout error:', waErr.message);
          }
        }
      }
      return res.status(200).json({ success: true, message: 'Mock payment verified successfully.' });
    }

    if (!finalSessionId) {
      // If leadId is passed and no session ID provided, check if lead is already paid
      if (leadId) {
        return res.status(200).json({ success: true, message: 'Lead recorded.' });
      }
      return res.status(400).json({ success: false, message: 'No session ID or payment ID provided.' });
    }

    const session = await stripe.checkout.sessions.retrieve(finalSessionId);

    if (session.payment_status === 'paid' || session.status === 'complete') {
      // 1. Check if this session is for a Lead (e.g. Sworn Translation)
      const targetLeadId = session.metadata?.leadId || session.client_reference_id || leadId;
      if (targetLeadId) {
        try {
          const leadObj = await prisma.lead.findUnique({ where: { id: targetLeadId } });
          if (leadObj && (leadObj.serviceType === 'Spanish Sworn Translation' || session.metadata?.serviceType === 'Spanish Sworn Translation')) {
            const { handleSwornTranslationPaymentSuccess } = require('../services/translationPaymentService');
            await handleSwornTranslationPaymentSuccess({
              leadId: targetLeadId,
              session,
              reqApp: req.app
            });
            console.log(`[Stripe Verification] Successfully executed Sworn Translation workflow for Lead ${targetLeadId}`);
          } else if (leadObj) {
            let existingQual = leadObj.qualificationData || {};
            if (typeof existingQual !== 'object') existingQual = {};
            await prisma.lead.update({
              where: { id: targetLeadId },
              data: {
                status: 'Payment Completed',
                qualificationData: {
                  ...existingQual,
                  paymentStatus: 'Paid',
                  paidAt: new Date().toISOString(),
                  stripeSessionId: session.id,
                  totalPaid: session.amount_total ? session.amount_total / 100 : (existingQual.estimatedPrice || leadObj.wordCount ? existingQual.estimatedPrice : 0)
                }
              }
            });
            console.log(`[Stripe Verification] Successfully updated Lead ${targetLeadId} status to Payment Completed.`);
          }
        } catch (leadUpdateErr) {
          console.warn('[Stripe Verification Lead Update Error]:', leadUpdateErr.message);
        }
      }

      const metadataPaymentId = session.metadata?.paymentId || paymentId;
      const metadataClientId = session.metadata?.clientId;
      const packageId = session.metadata?.packageId;

      if (metadataPaymentId) {
        const payment = await prisma.payment.findUnique({ where: { id: metadataPaymentId } });
        if (payment && payment.status !== 'Paid') {
          
          let snapshotRate = 0;
          const clientWithAgent = await prisma.client.findUnique({
            where: { id: payment.clientId },
            include: { assignedTo: true }
          });
          if (clientWithAgent && clientWithAgent.assignedTo) {
            snapshotRate = clientWithAgent.assignedTo.commissionRate || 0;
          }

          await prisma.payment.update({
            where: { id: metadataPaymentId },
            data: {
              status: 'Paid',
              transactionId: session.id,
              paymentMethod: 'Stripe',
              totalPaid: session.amount_total / 100,
              commissionRate: snapshotRate
            }
          });

          const isOptionA = payment.packageType === 'OPTION_A' || payment.packageType === 'option_a' || packageId === 'OPTION_A' || packageId === 'option_a';
          const client = await prisma.client.update({
            where: { id: metadataClientId || payment.clientId },
            data: {
              packageId: packageId || undefined,
              documentUploadAllowed: true,
              status: isOptionA ? 'Partially Paid' : 'Payment Completed',
              visaStatus: isOptionA ? 'Not Started' : 'Document Preparation'
            }
          });

          // Dispatch WhatsApp & Email Payment Receipts with Zoho Invoice Link
          try {
            let zohoInvoiceUrl = null;
            try {
              const zohoInvoiceService = require('../services/zohoInvoiceService');
              const zohoRes = await zohoInvoiceService.createZohoInvoice({
                client,
                amount: Number(payment.amount) || 0,
                discount: Number(payment.discount) || 0,
                netAmount: session.amount_total / 100,
                serviceType: client.serviceType,
                dueDate: payment.dueDate
              });
              if (zohoRes && (zohoRes.invoiceUrl || zohoRes.paymentUrl)) {
                zohoInvoiceUrl = zohoRes.invoiceUrl || zohoRes.paymentUrl;
                if (zohoRes.invoiceNumber) {
                  await prisma.payment.update({
                    where: { id: payment.id },
                    data: { invoiceNumber: zohoRes.invoiceNumber, gatewayId: zohoRes.invoiceId || undefined }
                  }).catch(() => null);
                }
              }
            } catch (zohoErr) {
              console.warn('[Zoho Invoice Engine] Warning:', zohoErr.message);
            }

            const invoiceLink = zohoInvoiceUrl || `${process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app'}/#/portal/login?zoho_fallback=true`;

            // Send Branded Payment Receipt & Checklist Email
            try {
              const { sendVisaChecklist } = require('../services/emailService');
              sendVisaChecklist(client.email, `${client.firstName} ${client.lastName}`, client.serviceType, {
                clientCode: client.clientCode,
                amount: session.amount_total / 100 || payment.amount,
                packageName: payment.packageType || client.serviceType,
                transactionId: session.id || payment.transactionId,
                dateStr: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
                invoiceUrl: invoiceLink
              })
                .then(() => console.log(`[Auto-Checklist] Sent receipt email to client ${client.email}`))
                .catch(emailErr => console.error('[Auto-Checklist] Failed to send receipt email:', emailErr.message));
            } catch (emailErr) {
              console.error('[Auto-Checklist] Error invoking receipt email:', emailErr.message);
            }

            if (client && client.phone) {
              const { sendPaymentSuccessWhatsApp } = require('../services/whatsappService');
              sendPaymentSuccessWhatsApp({
                client,
                paymentId: payment.id,
                amount: session.amount_total / 100,
                serviceType: client.serviceType,
                transactionId: session.id,
                zohoInvoiceUrl: zohoInvoiceUrl
              }).catch(err => console.error('[BG-WA] Payment receipt WA failed:', err.message));
              console.log(`[Auto-WhatsApp Payment Receipt] Dispatched Stripe checkout receipt to ${client.phone}`);
            }
          } catch (waErr) {
            console.error('[Auto-WhatsApp Payment Receipt] Stripe checkout error:', waErr.message);
          }
        }
      }

      return res.status(200).json({ success: true, message: 'Payment successfully verified!' });
    }

    return res.status(400).json({ success: false, message: 'Payment not completed.' });

  } catch (error) {
    console.error('Error verifying Stripe session:', error);
    res.status(500).json({ success: false, message: 'Server error verifying payment session' });
  }
};

const getCommissionHistory = async (req, res) => {
  try {
    const { agentId } = req.params;
    const history = await prisma.commissionRateHistory.findMany({
      where: { agentId },
      include: {
        changedBy: {
          select: { fullName: true, email: true, role: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(history);
  } catch (error) {
    console.error('Error fetching commission history:', error);
    res.status(500).json({ message: 'Server error fetching commission history' });
  }
};

const getClientPackages = async (req, res) => {
  try {
    const clientId = req.user.id;
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const activeCredit = await prisma.payment.findFirst({
      where: {
        clientId: clientId,
        status: 'Paid',
        assessmentCreditUsed: false,
        OR: [
          { packageType: 'OPTION_A' },
          { amount: 250 },
          { amount: 262.5 }
        ],
        AND: [
          {
            OR: [
              { paidAt: { gte: fourteenDaysAgo } },
              { AND: [{ paidAt: null }, { createdAt: { gte: fourteenDaysAgo } }] }
            ]
          },
          {
            OR: [
              { creditReservedForPaymentId: null },
              { creditReservedUntil: { lt: new Date() } }
            ]
          }
        ]
      }
    });

    res.json({
      success: true,
      packages: packagesConfig,
      credit: {
        hasCredit: !!activeCredit,
        creditAmount: activeCredit ? 250 : 0,
        expiresAt: activeCredit ? new Date((activeCredit.paidAt || activeCredit.createdAt).getTime() + 14 * 24 * 60 * 60 * 1000) : null
      }
    });
  } catch (error) {
    console.error('Error fetching packages config:', error);
    res.status(500).json({ message: 'Server error fetching packages configuration' });
  }
};

const createPackageCheckout = async (req, res) => {
  let createdPaymentId = null;
  let reservedAssessmentId = null;
  
  try {
    const { packageId, additionalApplicants, clientId: bodyClientId } = req.body;
    const clientId = bodyClientId || req.user.id;
    if (!packageId || additionalApplicants === undefined) {
      return res.status(400).json({ message: 'Package selection and applicant count are required.' });
    }

    const count = parseInt(additionalApplicants, 10);
    if (isNaN(count) || count < 0) {
      return res.status(400).json({ message: 'Invalid additional applicants count.' });
    }

    // STEP 1: DB Transaction - calculate, create pending payment, and reserve credit atomically
    const { payment, invoice } = await prisma.$transaction(async (tx) => {
      // Recalculate everything on backend
      const invoice = await paymentService.calculatePackageInvoice(clientId, packageId, count);

      // Verify the Option A payment is still lockable if credit was applied
      if (invoice.assessmentPaymentId) {
        const assessment = await tx.payment.findUnique({
          where: { id: invoice.assessmentPaymentId }
        });

        if (!assessment || assessment.status !== 'Paid' || assessment.assessmentCreditUsed) {
          throw new Error('Option A credit is no longer eligible or has already been used.');
        }

        // Lock if reserved is empty OR expired
        if (assessment.creditReservedForPaymentId && assessment.creditReservedUntil && assessment.creditReservedUntil >= new Date()) {
          throw new Error('Option A credit is currently reserved by another pending checkout.');
        }
      }

      // Create the pending Payment record
      // dueDate is kept for schema compatibility (14 days from creation)
      const newPayment = await tx.payment.create({
        data: {
          clientId,
          amount: invoice.total,
          packageType: packageId,
          additionalApplicants: count,
          status: 'Pending',
          paymentMethod: 'STRIPE',
          dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          invoiceSnapshot: invoice
        }
      });

      // Atomically set the reservation details on Option A payment
      if (invoice.assessmentPaymentId) {
        await tx.payment.update({
          where: { id: invoice.assessmentPaymentId },
          data: {
            creditReservedForPaymentId: newPayment.id,
            creditReservedUntil: new Date(Date.now() + 60 * 60 * 1000) // 1 hour reservation config
          }
        });
      }

      return { payment: newPayment, invoice };
    });

    createdPaymentId = payment.id;
    reservedAssessmentId = invoice.assessmentPaymentId;

    // STEP 2: Decoupled Stripe API Call (Outside Transaction)
    // Use req.headers.origin to ensure we return to the exact frontend that initiated the request
    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    let paymentUrl = `${frontendUrl}/#/portal/documents/${clientId}`;

    if (stripe) {
      const clientRec = await prisma.client.findUnique({ where: { id: clientId }, select: { clientCode: true } }).catch(() => null);
      const customerIdDisplay = clientRec?.clientCode || clientId;
      const stripeAmount = Math.round(invoice.total * 100); // convert EUR to integer cents
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: invoice.packageName,
              description: `Residency package checkout for Customer ID: ${customerIdDisplay}`
            },
            unit_amount: stripeAmount
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: `${frontendUrl}/#/public/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}/#/portal/documents/${clientId}?cancelled=true`,
        client_reference_id: payment.id,
        metadata: {
          clientId,
          paymentId: payment.id,
          packageId,
          additionalApplicants: count,
          assessmentPaymentId: invoice.assessmentPaymentId || '',
          type: 'package_payment'
        }
      });

      if (session && session.url) {
        paymentUrl = session.url;

        // STEP 3: DB Update - Save Stripe session ID
        await prisma.payment.update({
          where: { id: payment.id },
          data: { gatewayId: session.id }
        });
      }
    }

    res.status(201).json({
      success: true,
      payment,
      stripeUrl: paymentUrl
    });

  } catch (error) {
    console.error('Error initiating package checkout:', error.message);

    // STEP 4: Failure Recovery - Release reservation and mark payment failed
    if (createdPaymentId) {
      try {
        await prisma.payment.update({
          where: { id: createdPaymentId },
          data: { status: 'Failed' }
        });

        if (reservedAssessmentId) {
          await prisma.payment.update({
            where: { id: reservedAssessmentId },
            data: {
              creditReservedForPaymentId: null,
              creditReservedUntil: null
            }
          });
        }
      } catch (recoveryErr) {
        console.error('Error during payment checkout failure recovery:', recoveryErr.message);
      }
    }

    res.status(500).json({ message: error.message || 'Server error initiating package checkout' });
  }
};

const getPaymentBySessionId = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const clientId = req.user.id;

    if (!sessionId) {
      return res.status(400).json({ message: 'Session ID is required.' });
    }

    const payment = await prisma.payment.findFirst({
      where: { gatewayId: sessionId }
    });

    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found.' });
    }

    // Security: Enforce Client Ownership check
    if (payment.clientId !== clientId) {
      return res.status(403).json({ message: 'Access Denied: You do not own this payment record.' });
    }

    res.json({
      success: true,
      payment
    });
  } catch (error) {
    console.error('Error fetching payment by session:', error);
    res.status(500).json({ message: 'Server error fetching payment details.' });
  }
};

const getRevenueAnalytics = async (req, res) => {
  try {
    const revenueService = require('../services/revenueService');
    const analytics = await revenueService.getRevenueAnalytics(req.user?.role, req.user?.id);
    return res.status(200).json({
      success: true,
      ...analytics
    });
  } catch (error) {
    console.error('[getRevenueAnalytics Error]:', error.message);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error calculating revenue analytics', 
      error: error.message 
    });
  }
};

module.exports = { 
  getPayments, 
  generatePaymentLink, 
  updatePaymentStatus,
  getRefundRequests,
  createRefundRequest,
  updateRefundStatus,
  getCommissionRates,
  updateCommissionRate,
  getCommissionsReport,
  createStripeCheckoutSession,
  verifyStripeCheckoutSession,
  getCommissionHistory,
  getClientPackages,
  createPackageCheckout,
  getPaymentBySessionId,
  getRevenueAnalytics
};
