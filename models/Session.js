import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 },
  unavailable: { type: Boolean, default: false },
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['pending', 'paid', 'cash', 'treated'],
    default: 'pending',
  },
  method: {
    type: String,
    enum: ['transfer', 'cash', 'treated'],
    default: 'transfer',
  },
  paidBy: { type: String, default: null, trim: true },
  confirmedByHost: { type: Boolean, default: false },
  paidAt: { type: Date, default: null },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  participantName: { type: String, required: true, trim: true },
  items: [orderItemSchema],
  payment: { type: paymentSchema, default: () => ({}) },
  // DEPRECATED — kept for backward compat migration
  paymentSent: { type: Boolean, default: false },
  submittedAt: { type: Date, default: Date.now },
}, { _id: false });

const sessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  hostName: { type: String, required: true, trim: true },
  hostPaymentInfo: { type: String, required: true, trim: true },
  deliveryFee: { type: Number, required: true, default: 0 },
  deadline: { type: Date, default: null },
  restaurantId: { type: String, default: null },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
  },
  orders: [orderSchema],
  createdAt: {
    type: Date,
    default: Date.now,
    index: { expires: 172800 }, // TTL: 48 hours
  },
});

const Session = mongoose.model('Session', sessionSchema);
export default Session;
