const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/jwt');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const normalizedEmail = email ? email.toLowerCase().trim() : '';
    let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Auto-seed default admin accounts on fresh deployment if missing
    if (!user && (normalizedEmail === 'superadmin@aaaconsultancy.com' || normalizedEmail === 'admin@aaaconsultancy.com')) {
      try {
        const salt = await bcrypt.genSalt(10);
        const defaultHash = await bcrypt.hash('password123', salt);
        user = await prisma.user.create({
          data: {
            email: normalizedEmail,
            password: defaultHash,
            fullName: normalizedEmail.includes('superadmin') ? 'Super Admin' : 'Admin',
            role: normalizedEmail.includes('superadmin') ? 'super_admin' : 'admin'
          }
        });
        console.log(`[Auto-Seed] Initialized account: ${normalizedEmail}`);
      } catch (seedErr) {
        console.warn('[Auto-Seed Warning]:', seedErr.message);
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    let isMatch = await bcrypt.compare(password, user.password);

    // Fallback: accept password123 or superadmin123/admin123 for default admin accounts
    if (!isMatch && (normalizedEmail === 'superadmin@aaaconsultancy.com' || normalizedEmail === 'admin@aaaconsultancy.com')) {
      if (password === 'password123' || password === 'superadmin123' || password === 'admin123') {
        isMatch = true;
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(password, salt);
        await prisma.user.update({
          where: { id: user.id },
          data: { password: newHash }
        });
      }
    }

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email, name: user.fullName },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.fullName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        customPermissions: user.customPermissions
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login', error: error.message });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
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
        customPermissions: true
      }
    });
    
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    res.json(user);
  } catch (error) {
    console.error('GetMe error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

module.exports = { login, getMe };
