const prisma = require('./src/config/db');
const { getRevenueAnalytics } = require('./src/services/revenueService');

async function runRevenueTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING PRODUCTION REVENUE ANALYTICS TESTS');
  console.log('====================================================');

  try {
    const analytics = await getRevenueAnalytics('super_admin');

    console.log('\n📊 Analytics Result Object:');
    console.log({
      totalRevenue: analytics.totalRevenue,
      revenueToday: analytics.revenueToday,
      revenueThisWeek: analytics.revenueThisWeek,
      revenueThisMonth: analytics.revenueThisMonth,
      revenueThisYear: analytics.revenueThisYear,
      outstandingRevenue: analytics.outstandingRevenue,
      netRevenue: analytics.netRevenue,
      totalRefunded: analytics.totalRefunded,
      totalPaidClients: analytics.totalPaidClients,
      servicesCount: analytics.revenueByService.length,
      consultantsCount: analytics.revenueByConsultant.length,
      paymentMethodsCount: analytics.revenueByPaymentMethod.length
    });

    // 1. Metric existence & type assertions
    console.log('\n🔍 [TEST 1]: Checking 10 Mandatory Metrics Presence & Types...');
    const numericKeys = [
      'totalRevenue',
      'revenueToday',
      'revenueThisWeek',
      'revenueThisMonth',
      'revenueThisYear',
      'outstandingRevenue',
      'netRevenue',
      'totalRefunded',
      'totalPaidClients'
    ];

    for (const key of numericKeys) {
      if (typeof analytics[key] !== 'number' || isNaN(analytics[key])) {
        throw new Error(`Metric ${key} is not a valid number: ${analytics[key]}`);
      }
      console.log(`  ✅ Metric ${key}: ${analytics[key]}`);
    }

    // 2. Net Revenue formula assertion (Net Revenue <= Total Revenue)
    console.log('\n🔍 [TEST 2]: Checking Net Revenue Formula...');
    const expectedNet = Math.max(0, Math.round((analytics.totalRevenue - analytics.totalRefunded) * 100) / 100);
    if (analytics.netRevenue !== expectedNet) {
      throw new Error(`Net revenue mismatch: Expected ${expectedNet}, got ${analytics.netRevenue}`);
    }
    console.log(`  ✅ Net Revenue (€${analytics.netRevenue}) = Total Revenue (€${analytics.totalRevenue}) - Refunded (€${analytics.totalRefunded})`);

    // 3. Revenue by Service breakdown assertion
    console.log('\n🔍 [TEST 3]: Checking Revenue by Service...');
    if (!Array.isArray(analytics.revenueByService)) {
      throw new Error('revenueByService must be an array');
    }
    analytics.revenueByService.forEach((s, idx) => {
      if (!s.service || typeof s.revenue !== 'number' || typeof s.transactionsCount !== 'number' || typeof s.percentage !== 'number') {
        throw new Error(`Invalid service breakdown at index ${idx}: ${JSON.stringify(s)}`);
      }
      console.log(`  💼 Service: "${s.service}" | Revenue: €${s.revenue} | Deals: ${s.transactionsCount} | Share: ${s.percentage}%`);
    });

    // 4. Revenue by Consultant breakdown assertion
    console.log('\n🔍 [TEST 4]: Checking Revenue by Consultant...');
    if (!Array.isArray(analytics.revenueByConsultant)) {
      throw new Error('revenueByConsultant must be an array');
    }
    analytics.revenueByConsultant.forEach((c, idx) => {
      if (!c.consultantName || typeof c.revenue !== 'number' || typeof c.transactionsCount !== 'number' || typeof c.percentage !== 'number') {
        throw new Error(`Invalid consultant breakdown at index ${idx}: ${JSON.stringify(c)}`);
      }
      console.log(`  👤 Consultant: "${c.consultantName}" (${c.consultantId}) | Revenue: €${c.revenue} | Deals: ${c.transactionsCount} | Share: ${c.percentage}%`);
    });

    // 5. Revenue by Payment Method breakdown assertion
    console.log('\n🔍 [TEST 5]: Checking Revenue by Payment Method...');
    if (!Array.isArray(analytics.revenueByPaymentMethod)) {
      throw new Error('revenueByPaymentMethod must be an array');
    }
    analytics.revenueByPaymentMethod.forEach((m, idx) => {
      if (!m.method || typeof m.revenue !== 'number' || typeof m.transactionsCount !== 'number' || typeof m.percentage !== 'number') {
        throw new Error(`Invalid method breakdown at index ${idx}: ${JSON.stringify(m)}`);
      }
      console.log(`  💳 Method: "${m.method}" | Revenue: €${m.revenue} | Txns: ${m.transactionsCount} | Share: ${m.percentage}%`);
    });

    // 6. Outstanding Revenue assertion
    console.log('\n🔍 [TEST 6]: Checking Outstanding Revenue...');
    if (analytics.outstandingRevenue < 0) {
      throw new Error('Outstanding revenue cannot be negative');
    }
    console.log(`  ✅ Outstanding Receivables: €${analytics.outstandingRevenue}`);

    console.log('\n====================================================');
    console.log('🎉 ALL REVENUE ANALYTICS INTEGRATION TESTS PASSED!');
    console.log('====================================================\n');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runRevenueTests();
