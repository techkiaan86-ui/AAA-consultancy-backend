const prisma = require('../config/db');

/**
 * Helper to resolve clean human-readable service name from payment / client / lead
 */
const resolveServiceName = (payment) => {
  // 1. Direct payment purpose or packageType
  const purpose = (payment.paymentPurpose || '').trim();
  const pkgType = (payment.packageType || '').trim();
  const clientService = (payment.client?.serviceType || '').trim();
  const leadService = (payment.client?.lead?.serviceType || '').trim();
  const rawService = purpose || pkgType || clientService || leadService || '';

  const sLower = rawService.toLowerCase();

  if (sLower.includes('translation') || sLower.includes('sworn') || sLower.includes('traducci')) {
    return 'Spanish Sworn Translation';
  }
  if (sLower === 'full_process' || sLower.includes('full processing') || sLower.includes('option b') || sLower === 'opt_b') {
    return 'Full Processing Package (Spain Visa)';
  }
  if (sLower === 'premium' || sLower.includes('premium package') || sLower.includes('option c') || sLower.includes('option d') || sLower === 'opt_d') {
    return 'Premium Package (End-to-End + Relocation)';
  }
  if (sLower === 'relocation' || sLower.includes('administrative relocation') || sLower === 'opt_c') {
    return 'Administrative Relocation Package';
  }
  if (sLower === 'option_a' || sLower === 'standard' || sLower.includes('case assessment') || sLower.includes('consultation')) {
    return 'Professional Case Assessment';
  }
  if (sLower.includes('dnv') || sLower.includes('digital nomad')) {
    return 'Digital Nomad Visa (DNV)';
  }
  if (sLower.includes('nlv') || sLower.includes('non-lucrative')) {
    return 'Non-Lucrative Visa (NLV)';
  }
  if (sLower.includes('golden')) {
    return 'Golden Visa (Residency by Investment)';
  }
  if (sLower.includes('student') || sLower.includes('study')) {
    return 'Student Visa';
  }
  if (sLower.includes('property') || sLower.includes('real estate')) {
    return 'Property & Investment Advisory';
  }
  if (sLower.includes('tourist')) {
    return 'Tourist / Schengen Visa Support';
  }
  if (rawService) {
    return rawService.charAt(0).toUpperCase() + rawService.slice(1);
  }
  return 'Spain Relocation Legal Package';
};

/**
 * Helper to resolve clean payment method name
 */
const resolvePaymentMethod = (method) => {
  if (!method) return 'Card / Online';
  const m = String(method).trim().toUpperCase();
  if (m === 'STRIPE' || m === 'CARD' || m === 'VISA' || m === 'MASTERCARD') {
    return 'Stripe / Credit Card';
  }
  if (m.includes('TABBY')) {
    return 'Tabby (BNPL)';
  }
  if (m.includes('TAMARA')) {
    return 'Tamara (BNPL)';
  }
  if (m.includes('BANK') || m.includes('TRANSFER') || m.includes('NBD') || m.includes('WIRE')) {
    return 'Bank Transfer (Emirates NBD)';
  }
  return method;
};

/**
 * Get comprehensive, authoritative revenue analytics directly from database
 */
const getRevenueAnalytics = async (userRole = 'super_admin', userId = null) => {
  const now = new Date();

  // Time boundaries (Business Timezone Aware)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  // Monday 00:00:00 for start of current week
  const startOfWeek = new Date(now);
  const day = startOfWeek.getDay(); // 0 is Sunday, 1 is Monday...
  const diffToMonday = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
  startOfWeek.setDate(diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  // 1st of current month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  // Jan 1 of current year
  const startOfYear = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);

  // 1. Fetch all payments with relations
  const payments = await prisma.payment.findMany({
    include: {
      client: {
        select: {
          id: true,
          clientCode: true,
          firstName: true,
          lastName: true,
          serviceType: true,
          assignedToId: true,
          assignedTo: {
            select: {
              id: true,
              fullName: true,
              email: true,
              avatar: true,
              role: true
            }
          },
          lead: {
            select: {
              id: true,
              serviceType: true,
              assignedToId: true,
              assignedTo: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  avatar: true,
                  role: true
                }
              }
            }
          }
        }
      }
    }
  });

  // 2. Fetch all refund requests
  const refundRequests = await prisma.refundRequest.findMany({
    where: {
      status: { in: ['Approved', 'Processed'] }
    }
  });

  const totalRefunded = Math.round(
    refundRequests.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) * 100
  ) / 100;

  // 3. Initialize metrics
  let totalRevenue = 0;
  let revenueToday = 0;
  let revenueThisWeek = 0;
  let revenueThisMonth = 0;
  let revenueThisYear = 0;
  let outstandingRevenue = 0;

  const paidClientIds = new Set();
  const serviceRevenueMap = {};
  const consultantRevenueMap = {};
  const methodRevenueMap = {};
  const monthlyRevenueMap = {};

  // Initialize last 6 months in monthlyRevenueMap for trends
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    monthlyRevenueMap[monthKey] = 0;
  }

  // 4. Process payments
  for (const p of payments) {
    const sLower = (p.status || '').toLowerCase();
    const isPaid = [
      'paid',
      'completed',
      'payment received',
      'payment completed',
      'succeeded',
      'success',
      'paid fees'
    ].includes(sLower) || (p.totalPaid && Number(p.totalPaid) > 0 && sLower !== 'pending' && sLower !== 'pending payment' && sLower !== 'overdue');
    
    const isPending = sLower === 'pending' || sLower === 'pending payment' || sLower === 'overdue' || sLower === 'waiting for payment';

    const pGross = Number(p.amount) || 0;
    const pDiscount = Number(p.discount) || 0;
    const pNetDue = Math.max(0, pGross - pDiscount);
    const pTotalPaid = Number(p.totalPaid) || (isPaid ? pNetDue : 0);

    if (isPaid) {
      const recognizedAmount = pTotalPaid > 0 ? pTotalPaid : pNetDue;
      totalRevenue += recognizedAmount;

      if (p.clientId) {
        paidClientIds.add(p.clientId);
      }

      // Date resolution: prefer paidAt, then billingDate, then createdAt, then dueDate
      const rawDate = p.paidAt || p.billingDate || p.createdAt || p.dueDate;
      const paymentDate = rawDate ? new Date(rawDate) : new Date();

      if (paymentDate >= startOfToday && paymentDate <= endOfToday) {
        revenueToday += recognizedAmount;
      }
      if (paymentDate >= startOfWeek && paymentDate <= now) {
        revenueThisWeek += recognizedAmount;
      }
      if (paymentDate >= startOfMonth && paymentDate <= now) {
        revenueThisMonth += recognizedAmount;
      }
      if (paymentDate >= startOfYear && paymentDate <= now) {
        revenueThisYear += recognizedAmount;
      }

      // Monthly Trend tracking
      const monthKey = paymentDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      if (monthlyRevenueMap[monthKey] !== undefined) {
        monthlyRevenueMap[monthKey] = Math.round((monthlyRevenueMap[monthKey] + recognizedAmount) * 100) / 100;
      }

      // Revenue by Service Breakdown
      const serviceName = resolveServiceName(p);
      if (!serviceRevenueMap[serviceName]) {
        serviceRevenueMap[serviceName] = { revenue: 0, count: 0 };
      }
      serviceRevenueMap[serviceName].revenue += recognizedAmount;
      serviceRevenueMap[serviceName].count += 1;

      // Revenue by Consultant Breakdown
      const consultant = p.client?.assignedTo || p.client?.lead?.assignedTo;
      const consultantKey = consultant?.id || 'unassigned';
      const consultantName = consultant?.fullName || 'Unassigned';
      const consultantAvatar = consultant?.avatar || null;

      if (!consultantRevenueMap[consultantKey]) {
        consultantRevenueMap[consultantKey] = {
          id: consultantKey,
          name: consultantName,
          avatar: consultantAvatar,
          revenue: 0,
          count: 0
        };
      }
      consultantRevenueMap[consultantKey].revenue += recognizedAmount;
      consultantRevenueMap[consultantKey].count += 1;

      // Revenue by Payment Method Breakdown
      const methodName = resolvePaymentMethod(p.paymentMethod);
      if (!methodRevenueMap[methodName]) {
        methodRevenueMap[methodName] = { revenue: 0, count: 0 };
      }
      methodRevenueMap[methodName].revenue += recognizedAmount;
      methodRevenueMap[methodName].count += 1;

    } else if (isPending) {
      // Calculate remaining unpaid balance
      const unpaidBalance = Math.max(0, pNetDue - pTotalPaid);
      outstandingRevenue += unpaidBalance;
    }
  }

  // Round core totals
  totalRevenue = Math.round(totalRevenue * 100) / 100;
  revenueToday = Math.round(revenueToday * 100) / 100;
  revenueThisWeek = Math.round(revenueThisWeek * 100) / 100;
  revenueThisMonth = Math.round(revenueThisMonth * 100) / 100;
  revenueThisYear = Math.round(revenueThisYear * 100) / 100;
  outstandingRevenue = Math.round(outstandingRevenue * 100) / 100;
  const netRevenue = Math.max(0, Math.round((totalRevenue - totalRefunded) * 100) / 100);

  // Format Revenue by Service array
  const revenueByService = Object.entries(serviceRevenueMap)
    .map(([serviceName, data]) => ({
      service: serviceName,
      revenue: Math.round(data.revenue * 100) / 100,
      transactionsCount: data.count,
      percentage: totalRevenue > 0 ? Math.round((data.revenue / totalRevenue) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Format Revenue by Consultant array
  const revenueByConsultant = Object.values(consultantRevenueMap)
    .map((c) => ({
      consultantId: c.id,
      consultantName: c.name,
      avatar: c.avatar,
      revenue: Math.round(c.revenue * 100) / 100,
      transactionsCount: c.count,
      percentage: totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Format Revenue by Payment Method array
  const revenueByPaymentMethod = Object.entries(methodRevenueMap)
    .map(([methodName, data]) => ({
      method: methodName,
      revenue: Math.round(data.revenue * 100) / 100,
      transactionsCount: data.count,
      percentage: totalRevenue > 0 ? Math.round((data.revenue / totalRevenue) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Format Monthly Trends array
  const monthlyTrends = Object.entries(monthlyRevenueMap).map(([month, revenue]) => ({
    month,
    revenue
  }));

  return {
    totalRevenue,
    revenueToday,
    revenueThisWeek,
    revenueThisMonth,
    revenueThisYear,
    outstandingRevenue,
    netRevenue,
    totalRefunded,
    totalPaidClients: paidClientIds.size,
    revenueByService,
    revenueByConsultant,
    revenueByPaymentMethod,
    monthlyTrends
  };
};

module.exports = {
  getRevenueAnalytics,
  resolveServiceName,
  resolvePaymentMethod
};
