import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import { auth } from '../middleware/auth.js';
import { sendOTPEmail } from '../services/email.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const OTP_EXPIRY_MINUTES = 10;

// Toggle OTP on/off — set to true to require email OTP verification
const OTP_ENABLED = process.env.OTP_ENABLED === 'true';

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function generateAccessToken(user) {
  return jwt.sign(
    { id: user._id, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    { id: user._id },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

function issueTokens(user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  user.refreshTokens.push({ token: refreshToken });
  if (user.refreshTokens.length > 5) {
    user.refreshTokens = user.refreshTokens.slice(-5);
  }
  return { accessToken, refreshToken };
}

// ======================== SIGNUP ========================
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, paymentInfo } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing && existing.isVerified) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Build or update user
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    let user;
    if (existing && !existing.isVerified) {
      existing.name = name.trim();
      existing.password = password;
      existing.paymentInfo = (paymentInfo || '').trim();
      existing.otp = otp;
      existing.otpExpiresAt = otpExpiresAt;
      if (!OTP_ENABLED) existing.isVerified = true;
      user = existing;
    } else {
      user = new User({
        name: name.trim(),
        email: normalizedEmail,
        password,
        paymentInfo: (paymentInfo || '').trim(),
        otp,
        otpExpiresAt,
        isVerified: !OTP_ENABLED,
      });
    }

    if (OTP_ENABLED) {
      await user.save();
      await sendOTPEmail(normalizedEmail, otp);
      return res.status(200).json({
        message: 'Verification code sent to your email',
        email: normalizedEmail,
        requiresOTP: true,
      });
    }

    // OTP disabled → issue tokens directly
    const { accessToken, refreshToken } = issueTokens(user);
    await user.save();

    res.status(201).json({
      user: user.toJSON(),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ======================== VERIFY OTP ========================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!otp?.trim()) return res.status(400).json({ error: 'Verification code is required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.otp || user.otp !== otp.trim()) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
      return res.status(401).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpiresAt = null;

    const { accessToken, refreshToken } = issueTokens(user);
    await user.save();

    res.json({ user: user.toJSON(), accessToken, refreshToken });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ======================== LOGIN ========================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!password) return res.status(400).json({ error: 'Password is required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.isVerified && OTP_ENABLED) {
      const otp = generateOTP();
      user.otp = otp;
      user.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
      await user.save();
      await sendOTPEmail(user.email, otp);
      return res.status(200).json({
        message: 'Account not verified. A new verification code has been sent.',
        email: user.email,
        requiresOTP: true,
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid email or password' });

    if (OTP_ENABLED) {
      const otp = generateOTP();
      user.otp = otp;
      user.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
      await user.save();
      await sendOTPEmail(user.email, otp);
      return res.json({
        message: 'Verification code sent to your email',
        email: user.email,
        requiresOTP: true,
      });
    }

    // OTP disabled → issue tokens directly
    const { accessToken, refreshToken } = issueTokens(user);
    await user.save();

    res.json({ user: user.toJSON(), accessToken, refreshToken });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ======================== RESEND OTP ========================
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const otp = generateOTP();
    user.otp = otp;
    user.otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await user.save();

    await sendOTPEmail(user.email, otp);
    res.json({ message: 'New verification code sent' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// ======================== REFRESH TOKEN ========================
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const tokenExists = user.refreshTokens.some(t => t.token === refreshToken);
    if (!tokenExists) return res.status(401).json({ error: 'Refresh token has been revoked' });

    const newAccessToken = generateAccessToken(user);
    res.json({ accessToken: newAccessToken, user: user.toJSON() });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ======================== ME ========================
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.toJSON());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ======================== LOGOUT ========================
router.post('/logout', auth, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await User.findById(req.user.id);
    if (user && refreshToken) {
      user.refreshTokens = user.refreshTokens.filter(t => t.token !== refreshToken);
      await user.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
