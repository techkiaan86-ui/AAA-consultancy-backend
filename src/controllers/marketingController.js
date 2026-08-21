const prisma = require('../config/db');

const getMarketingSpend = async (req, res) => {
  try {
    const spendRecords = await prisma.marketingSpend.findMany();
    // Convert to an object { 'Facebook Ads': 1200, ... }
    const spendMap = {};
    spendRecords.forEach(record => {
      spendMap[record.channel] = record.amount;
    });
    res.json(spendMap);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching marketing spend', error: error.message });
  }
};

const updateMarketingSpend = async (req, res) => {
  try {
    const spendData = req.body; // e.g. { 'Facebook Ads': 1500, 'Google Ads': 2000 }
    
    // Upsert each channel
    for (const [channel, amount] of Object.entries(spendData)) {
      await prisma.marketingSpend.upsert({
        where: { channel },
        update: { amount: Number(amount) || 0 },
        create: { channel, amount: Number(amount) || 0 },
      });
    }

    res.json({ message: 'Marketing spend updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error updating marketing spend', error: error.message });
  }
};

module.exports = { getMarketingSpend, updateMarketingSpend };
