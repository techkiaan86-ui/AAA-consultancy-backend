const bcrypt = require('bcrypt');
const prisma = require('../config/db');

// @desc    Get all users (agents)
// @route   GET /api/v1/users/agents
// @access  Private (Admin/Super Admin)
const getAgents = async (req, res) => {
  try {
    let whereClause = {};
    if (req.user && req.user.role === 'admin') {
      whereClause = {
        OR: [
          { createdById: req.user.id },
          { id: req.user.id }
        ]
      };
    } else if (req.user && req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      whereClause = { id: req.user.id }; // Other roles only see themselves if they hit this route
    }

    const agents = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        hotlineNumber: true,
        spokenLanguages: true,
        nationalities: true,
        commissionRate: true,
        immigrationBio: true,
        customPermissions: true,
        avatar: true,
        createdAt: true
      }
    });
    // Add virtual fields for frontend mapping
    const mappedAgents = agents.map(a => ({
      ...a,
      name: a.fullName,
      phone: a.hotlineNumber,
      languages: a.spokenLanguages,
      bio: a.immigrationBio,
      casesCount: 0,
      avatar: a.avatar || null
    }));
    res.json(mappedAgents);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Create new user (agent)
// @route   POST /api/v1/users
// @access  Private (Super Admin)
const createUser = async (req, res) => {
  try {
    const {
      fullName, email, password, hotlineNumber, role,
      spokenLanguages, nationalities, commissionRate, immigrationBio, customPermissions
    } = req.body;

    const userExists = await prisma.user.findUnique({ where: { email } });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const rateNum = Number(commissionRate) || 0;

    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        password: hashedPassword,
        hotlineNumber,
        role: role || 'consultant',
        spokenLanguages,
        nationalities,
        commissionRate: rateNum,
        immigrationBio,
        customPermissions,
        createdById: req.user ? req.user.id : null
      }
    });

    // Create Initial Rate History Entry at Registration
    try {
      let changedById = req.user?.id;
      if (changedById) {
        const adminUser = await prisma.user.findUnique({ where: { id: changedById }, select: { id: true } });
        if (!adminUser) changedById = user.id;
      } else {
        changedById = user.id;
      }

      await prisma.commissionRateHistory.create({
        data: {
          agentId: user.id,
          oldRate: 0,
          newRate: rateNum,
          changedById: changedById,
          revenueAtChange: 0
        }
      });
    } catch (hErr) {
      console.error('Error logging initial commission rate history:', hErr);
    }

    res.status(201).json({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fullName, email, hotlineNumber, role,
      spokenLanguages, nationalities, commissionRate, immigrationBio, customPermissions
    } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const oldRate = Number(existingUser.commissionRate) || 0;
    const newRateNum = (commissionRate !== undefined && commissionRate !== null && !isNaN(Number(commissionRate)))
      ? Number(commissionRate)
      : oldRate;

    if (oldRate !== newRateNum) {
      try {
        // Calculate current revenue for this agent
        const agentClients = await prisma.client.findMany({
          where: { assignedToId: id },
          select: { id: true }
        });
        const clientIds = agentClients.map(c => c.id);
        const paidPayments = await prisma.payment.findMany({
          where: { clientId: { in: clientIds }, status: 'Paid' },
          select: { amount: true }
        });
        const totalRevenue = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

        // Determine valid changedById
        let changedById = req.user?.id;
        if (changedById) {
          const adminUser = await prisma.user.findUnique({ where: { id: changedById }, select: { id: true } });
          if (!adminUser) {
            changedById = id;
          }
        } else {
          changedById = id;
        }

        // Create Rate History Log
        await prisma.commissionRateHistory.create({
          data: {
            agentId: id,
            oldRate: oldRate,
            newRate: newRateNum,
            changedById: changedById,
            revenueAtChange: totalRevenue
          }
        });
      } catch (historyErr) {
        console.error('Error logging commission rate history:', historyErr);
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        fullName,
        email,
        hotlineNumber,
        role,
        spokenLanguages,
        nationalities,
        commissionRate: newRateNum,
        immigrationBio,
        customPermissions
      }
    });
    res.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: error.message || 'Server error' });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'User ID is required' });

    const userToDelete = await prisma.user.findUnique({ where: { id } });
    if (!userToDelete) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 1. Delete associated CommissionRateHistory records for this agent
    await prisma.commissionRateHistory.deleteMany({
      where: {
        OR: [
          { agentId: id },
          { changedById: id }
        ]
      }
    }).catch(e => console.warn('Could not delete commissionRateHistory:', e.message));

    // 2. Safely disassociate all linked entities before deleting the user
    await prisma.lead.updateMany({
      where: { assignedToId: id },
      data: { assignedToId: null }
    }).catch(e => console.warn('Could not disassociate assignedToId in Lead:', e.message));

    await prisma.client.updateMany({
      where: { assignedToId: id },
      data: { assignedToId: null }
    }).catch(e => console.warn('Could not disassociate assignedToId in Client:', e.message));

    await prisma.consultation.updateMany({
      where: { consultantId: id },
      data: { consultantId: null }
    }).catch(e => console.warn('Could not disassociate consultantId in Consultation:', e.message));

    await prisma.document.updateMany({
      where: { reviewedById: id },
      data: { reviewedById: null }
    }).catch(e => console.warn('Could not disassociate reviewedById in Document:', e.message));

    await prisma.discountCode.updateMany({
      where: { createdById: id },
      data: { createdById: null }
    }).catch(e => console.warn('Could not disassociate createdById in DiscountCode:', e.message));

    await prisma.communicationLog.updateMany({
      where: { respondedByUserId: id },
      data: { respondedByUserId: null }
    }).catch(e => console.warn('Could not disassociate respondedByUserId in CommunicationLog:', e.message));

    await prisma.user.updateMany({
      where: { createdById: id },
      data: { createdById: null }
    }).catch(e => console.warn('Could not disassociate createdById in User:', e.message));

    // 3. Delete the user from DB
    await prisma.user.delete({ where: { id } });

    console.log(`[User Controller] Successfully deleted user ID: ${id} (${userToDelete.fullName})`);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Failed to delete user', error: error.message });
  }
};

const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id },
      data: { password: hashedPassword }
    });
    res.json({ message: 'Password updated' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

const updateSuperAdminProfile = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Access denied. Only Super Admin can change Super Admin details.' });
    }

    const { fullName, email, hotlineNumber } = req.body;
    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ message: 'Super Admin full name is required.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        fullName: fullName.trim(),
        ...(email ? { email: email.toLowerCase().trim() } : {}),
        ...(hotlineNumber ? { hotlineNumber: hotlineNumber.trim() } : {})
      }
    });

    res.json({
      id: updatedUser.id,
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      role: updatedUser.role,
      name: updatedUser.fullName,
      hotlineNumber: updatedUser.hotlineNumber
    });
  } catch (error) {
    console.error('Error updating Super Admin profile:', error);
    res.status(500).json({ message: 'Server error updating Super Admin profile', error: error.message });
  }
};

module.exports = { getAgents, createUser, updateUser, deleteUser, resetUserPassword, updateSuperAdminProfile };
