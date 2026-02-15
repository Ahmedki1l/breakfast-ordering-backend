import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  paymentInfo: {
    type: String,
    default: '',
    trim: true,
  },
  otp: { type: String, default: null },
  otpExpiresAt: { type: Date, default: null },
  isVerified: { type: Boolean, default: false },
  refreshTokens: [{
    token: String,
    createdAt: { type: Date, default: Date.now },
  }],
}, {
  timestamps: true,
});

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  delete obj.otp;
  delete obj.otpExpiresAt;
  delete obj.__v;
  return obj;
};

const User = mongoose.model('User', userSchema);
export default User;
