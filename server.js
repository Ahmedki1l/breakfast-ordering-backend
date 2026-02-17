import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import connectDB from './db.js';
import Session from './models/Session.js';
import Restaurant from './models/Restaurant.js';
import restaurantRoutes from './restaurants.js';
import authRoutes from './routes/auth.js';
import { auth, optionalAuth } from './middleware/auth.js';
import User from './models/User.js';
import { sendPushToUser, sendPushToParticipant, sendPushToAllParticipants, VAPID_PUBLIC_KEY } from './services/pushService.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Mount routes
app.use('/api/auth', authRoutes);
app.use(restaurantRoutes);

// ======================== PUSH SUBSCRIPTION ========================

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Avoid duplicates
    const exists = user.pushSubscriptions?.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      user.pushSubscriptions = user.pushSubscriptions || [];
      user.pushSubscriptions.push(subscription);
      await user.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

app.delete('/api/push/subscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    const user = await User.findById(req.user.id);
    if (user) {
      user.pushSubscriptions = (user.pushSubscriptions || []).filter(s => s.endpoint !== endpoint);
      await user.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Helper: Calculate costs
function calculateCosts(session) {
  const participants = session.orders || [];
  const numParticipants = participants.length;
  
  if (numParticipants === 0) return [];
  
  const deliveryPerPerson = session.deliveryFee / numParticipants;
  
  return participants.map(order => {
    const itemsTotal = order.items.reduce((sum, item) => 
      sum + (item.unavailable ? 0 : (item.price * item.quantity)), 0
    );
    
    // Backward compat: migrate old paymentSent boolean to new payment object
    const payment = order.payment?.status
      ? order.payment
      : { status: order.paymentSent ? 'paid' : 'pending', method: 'transfer', paidBy: null, confirmedByHost: false, paidAt: null };
    
    return {
      name: order.participantName,
      itemsTotal,
      deliveryShare: deliveryPerPerson,
      total: itemsTotal + deliveryPerPerson,
      items: order.items,
      payment,
      // Keep for backward compat
      paymentSent: payment.status !== 'pending'
    };
  });
}

// ======================== SESSION ROUTES ========================

// Create session (requires auth)
app.post('/api/sessions', auth, async (req, res) => {
  try {
    const { hostPaymentInfo, deliveryFee, deadlineMinutes, restaurantId } = req.body;

    if (!hostPaymentInfo || typeof hostPaymentInfo !== 'string' || !hostPaymentInfo.trim()) {
      return res.status(400).json({ error: 'Payment info is required' });
    }
    const parsedDeliveryFee = parseFloat(deliveryFee);
    if (isNaN(parsedDeliveryFee) || parsedDeliveryFee < 0) {
      return res.status(400).json({ error: 'Delivery fee must be a non-negative number' });
    }

    const sessionId = nanoid(8);
    // Compute deadline: use provided minutes or default to 60
    const minutes = deadlineMinutes && parseInt(deadlineMinutes) > 0 ? parseInt(deadlineMinutes) : 60;
    const sessionDeadline = new Date(Date.now() + minutes * 60 * 1000);

    const session = new Session({
      sessionId,
      host: req.user.id,
      hostName: req.user.name,
      hostPaymentInfo: hostPaymentInfo.trim(),
      deliveryFee: parsedDeliveryFee,
      deadline: sessionDeadline,
      restaurantId: restaurantId || null,
      status: 'active',
      orders: []
    });

    await session.save();

    res.json({
      sessionId,
      url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/join/${sessionId}`
    });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Active sessions feed (sessions the user hosts or has ordered in)
app.get('/api/sessions/feed/active', auth, async (req, res) => {
  try {
    const sessions = await Session.find({
      status: 'active',
      $or: [
        { host: req.user.id },
        { 'orders.userId': req.user.id }
      ]
    }).sort({ createdAt: -1 }).lean();

    const feed = sessions.map(s => ({
      sessionId: s.sessionId,
      hostName: s.hostName,
      isHost: s.host.toString() === req.user.id,
      participantCount: s.orders.length,
      deadline: s.deadline,
      restaurantId: s.restaurantId,
      createdAt: s.createdAt,
    }));

    res.json(feed);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// User's order history
app.get('/api/sessions/history/mine', auth, async (req, res) => {
  try {
    const sessions = await Session.find({
      $or: [
        { host: req.user.id },
        { 'orders.userId': req.user.id }
      ]
    }).sort({ createdAt: -1 }).limit(20).lean();

    const history = sessions.map(s => {
      const myOrder = s.orders.find(o => o.userId?.toString() === req.user.id);
      return {
        sessionId: s.sessionId,
        hostName: s.hostName,
        isHost: s.host.toString() === req.user.id,
        status: s.status,
        restaurantId: s.restaurantId,
        createdAt: s.createdAt,
        myItems: myOrder?.items || [],
        myTotal: myOrder ? myOrder.items.reduce((sum, i) => sum + (i.price * (i.quantity || 1)), 0) : 0,
        paymentSent: myOrder?.paymentSent || false,
        payment: myOrder?.payment || { status: 'pending' },
      };
    });

    res.json(history);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get session (public view)
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const costs = calculateCosts(session);

    // Include restaurant data if session has a restaurant
    let restaurant = null;
    if (session.restaurantId) {
      restaurant = await Restaurant.findOne({ id: session.restaurantId }).lean();
    }

    res.json({
      sessionId: session.sessionId,
      hostName: session.hostName,
      hostPaymentInfo: session.hostPaymentInfo,
      deliveryFee: session.deliveryFee,
      deadline: session.deadline,
      restaurantId: session.restaurantId,
      status: session.status,
      createdAt: session.createdAt,
      orders: session.orders,
      host: session.host,
      costs,
      restaurant,
      summary: {
        totalFood: costs.reduce((sum, c) => sum + c.itemsTotal, 0),
        totalDelivery: session.deliveryFee,
        grandTotal: costs.reduce((sum, c) => sum + c.total, 0)
      }
    });
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Submit order (requires auth)
app.post('/api/sessions/:id/orders', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is closed' });
    }
    
    // Deadline enforcement
    if (session.deadline && new Date() > new Date(session.deadline)) {
      return res.status(400).json({ error: 'Order deadline has passed' });
    }
    
    const { items } = req.body;
    const participantName = req.user.name;
    
    // Input validation
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    for (const item of items) {
      if (!item.name || typeof item.name !== 'string' || !item.name.trim()) {
        return res.status(400).json({ error: 'Each item must have a name' });
      }
      if (typeof item.price !== 'number' || item.price <= 0) {
        return res.status(400).json({ error: 'Each item must have a positive price' });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ error: 'Each item must have a quantity of at least 1' });
      }
    }
    
    // Check if participant already ordered
    const existingIndex = session.orders.findIndex(
      o => o.participantName === participantName
    );
    
    const order = {
      user: req.user.id,
      participantName,
      items: items.map(i => ({ name: i.name.trim(), price: i.price, quantity: i.quantity })),
      paymentSent: false,
      submittedAt: new Date()
    };
    
    if (existingIndex >= 0) {
      session.orders[existingIndex] = order;
    } else {
      session.orders.push(order);
    }
    
    await session.save();
    
    // Broadcast update
    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Submit order error:', err);
    res.status(500).json({ error: 'Failed to submit order' });
  }
});

// Update payment status (enhanced — supports status, method, paidBy)
app.patch('/api/sessions/:id/orders/:name/payment', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const name = decodeURIComponent(req.params.name);
    const order = session.orders.find(o => o.participantName === name);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { status, method, paidBy, paymentSent } = req.body;
    
    // Support legacy boolean format
    if (paymentSent !== undefined && !status) {
      order.payment = {
        status: paymentSent ? 'paid' : 'pending',
        method: 'transfer',
        paidBy: paymentSent ? req.user.name : null,
        confirmedByHost: false,
        paidAt: paymentSent ? new Date() : null,
      };
      order.paymentSent = paymentSent;
    } else {
      order.payment = {
        status: status || 'paid',
        method: method || 'transfer',
        paidBy: paidBy || req.user.name,
        confirmedByHost: false,
        paidAt: new Date(),
      };
      order.paymentSent = status !== 'pending';
    }
    
    await session.save();
    
    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });
    
    res.json({ success: true });

    // Push notification → notify the host that someone paid
    sendPushToUser(session.host, {
      title: '💳 Payment Update',
      body: `${paidBy || req.user.name} marked payment for ${name}`,
      url: `/host/${req.params.id}`,
    }).catch(() => {});
  } catch (err) {
    console.error('Update payment error:', err);
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

// Host treats participants (عزمتك / عزمتكم)
app.post('/api/sessions/:id/treat', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    // Only host can treat
    if (session.host.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can treat participants' });
    }
    
    const { names } = req.body; // 'all' or ['Ahmed', 'Sara']
    const targetNames = names === 'all'
      ? session.orders.map(o => o.participantName)
      : Array.isArray(names) ? names : [names];
    
    let treated = 0;
    for (const order of session.orders) {
      if (targetNames.includes(order.participantName)) {
        order.payment = {
          status: 'treated',
          method: 'treated',
          paidBy: session.hostName,
          confirmedByHost: true,
          paidAt: new Date(),
        };
        order.paymentSent = true;
        treated++;
      }
    }
    
    await session.save();
    
    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });
    
    res.json({ success: true, treated });

    // Push notification → notify each treated participant
    for (const order of session.orders) {
      if (targetNames.includes(order.participantName) && order.user) {
        sendPushToUser(order.user, {
          title: '🎁 عزمتك!',
          body: `${session.hostName} is treating you! Your payment is covered.`,
          url: `/join/${req.params.id}`,
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Treat error:', err);
    res.status(500).json({ error: 'Failed to treat participants' });
  }
});

// Host confirms payment received
app.patch('/api/sessions/:id/orders/:name/confirm', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    if (session.host.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can confirm payments' });
    }
    
    const name = decodeURIComponent(req.params.name);
    const order = session.orders.find(o => o.participantName === name);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
    if (!order.payment) {
      order.payment = { status: 'paid', method: 'transfer', paidBy: name, paidAt: new Date() };
    }
    order.payment.confirmedByHost = true;
    order.paymentSent = true;
    
    await session.save();
    
    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });
    
    res.json({ success: true });

    // Push notification → notify the payer that host confirmed
    if (order.user) {
      sendPushToUser(order.user, {
        title: '✅ Payment Confirmed',
        body: `${session.hostName} confirmed your payment!`,
        url: `/join/${req.params.id}`,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('Confirm payment error:', err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// Close session
app.delete('/api/sessions/:id', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    
    if (session) {
      session.status = 'closed';
      await session.save();
      io.to(req.params.id).emit('session-closed');
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (err) {
    console.error('Close session error:', err);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

// Update delivery fee
app.patch('/api/sessions/:id/delivery-fee', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { deliveryFee } = req.body;
    const parsed = parseFloat(deliveryFee);
    if (isNaN(parsed) || parsed < 0) {
      return res.status(400).json({ error: 'Delivery fee must be a non-negative number' });
    }

    session.deliveryFee = parsed;
    await session.save();

    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session),
      deliveryFee: session.deliveryFee
    });

    res.json({ success: true, deliveryFee: parsed });
  } catch (err) {
    console.error('Update delivery fee error:', err);
    res.status(500).json({ error: 'Failed to update delivery fee' });
  }
});

// Delete a participant's order
app.delete('/api/sessions/:id/orders/:name', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const name = decodeURIComponent(req.params.name);
    const idx = session.orders.findIndex(o => o.participantName === name);
    if (idx < 0) return res.status(404).json({ error: 'Order not found' });

    session.orders.splice(idx, 1);
    await session.save();

    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Edit a participant's order (host can modify items)
app.put('/api/sessions/:id/orders/:name', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const name = decodeURIComponent(req.params.name);
    const order = session.orders.find(o => o.participantName === name);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

    // Update items
    order.items = items.map(i => ({
      name: (i.name || '').trim(),
      price: Number(i.price) || 0,
      quantity: parseInt(i.quantity) || 1,
      unavailable: !!i.unavailable
    })).filter(i => i.name);

    await session.save();

    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Edit order error:', err);
    res.status(500).json({ error: 'Failed to edit order' });
  }
});

// Update session restaurant (host only)
app.patch('/api/sessions/:id/restaurant', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.host.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can change the restaurant' });
    }

    const { restaurantId } = req.body;

    // Allow clearing restaurant (set to null)
    if (restaurantId) {
      const restaurant = await Restaurant.findOne({ id: restaurantId });
      if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    }

    session.restaurantId = restaurantId || null;
    await session.save();

    // Broadcast full session update so participants get the new menu
    const populatedSession = await Session.findOne({ sessionId: req.params.id });
    let restaurantData = null;
    if (populatedSession.restaurantId) {
      restaurantData = await Restaurant.findOne({ id: populatedSession.restaurantId });
    }

    io.to(req.params.id).emit('session-updated', {
      orders: populatedSession.orders,
      costs: calculateCosts(populatedSession),
      restaurantId: populatedSession.restaurantId,
      restaurant: restaurantData,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update restaurant error:', err);
    res.status(500).json({ error: 'Failed to update restaurant' });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join-session', (sessionId) => {
    socket.join(sessionId);
    console.log(`Client ${socket.id} joined session ${sessionId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

async function autoMigrateData() {
  const dataFile = path.join(process.cwd(), 'data', 'restaurants.json');
  if (!fs.existsSync(dataFile)) return;

  console.log('📦 Found data/restaurants.json — auto-migrating to MongoDB...');
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    let inserted = 0, skipped = 0;

    for (const r of data) {
      const exists = await Restaurant.findOne({ id: r.id });
      if (exists) { skipped++; continue; }

      await Restaurant.create({
        id: r.id,
        name: r.name,
        address: r.address || '',
        googleMapsUrl: r.googleMapsUrl || '',
        phone: r.phone || '',
        menuImages: r.menuImages || [],
        menuItems: r.menuItems || [],
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      });
      inserted++;
    }

    console.log(`✅ Migration complete: ${inserted} inserted, ${skipped} skipped`);

    // Rename the file so it's not re-processed next restart
    const migratedPath = dataFile + '.migrated';
    fs.renameSync(dataFile, migratedPath);
    console.log(`🗑️  Renamed restaurants.json → restaurants.json.migrated`);
  } catch (err) {
    console.error('⚠️  Auto-migration failed (non-fatal):', err.message);
  }
}

async function start() {
  await connectDB();
  await autoMigrateData();
  httpServer.listen(PORT, () => {
    console.log(`🍳 Breakfast ordering server running on port ${PORT}`);
  });
}

start();
