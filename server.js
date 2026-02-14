import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';
import restaurantRoutes from './restaurants.js';
import fs from 'fs';
import path from 'path';

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
app.use(restaurantRoutes);

// In-memory storage (sessions)
const sessions = new Map();

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
    
    return {
      name: order.participantName,
      itemsTotal,
      deliveryShare: deliveryPerPerson,
      total: itemsTotal + deliveryPerPerson,
      items: order.items,
      paymentSent: order.paymentSent || false
    };
  });
}

// Routes
app.post('/api/sessions', (req, res) => {
  const { hostName, hostPaymentInfo, deliveryFee, deadline, restaurantId } = req.body;
  
  // Input validation
  if (!hostName || typeof hostName !== 'string' || !hostName.trim()) {
    return res.status(400).json({ error: 'Host name is required' });
  }
  if (!hostPaymentInfo || typeof hostPaymentInfo !== 'string' || !hostPaymentInfo.trim()) {
    return res.status(400).json({ error: 'Payment info is required' });
  }
  const parsedDeliveryFee = parseFloat(deliveryFee);
  if (isNaN(parsedDeliveryFee) || parsedDeliveryFee < 0) {
    return res.status(400).json({ error: 'Delivery fee must be a non-negative number' });
  }
  if (deadline && isNaN(new Date(deadline).getTime())) {
    return res.status(400).json({ error: 'Invalid deadline format' });
  }
  
  const sessionId = nanoid(8);
  const session = {
    sessionId,
    hostName: hostName.trim(),
    hostPaymentInfo: hostPaymentInfo.trim(),
    deliveryFee: parsedDeliveryFee,
    deadline: deadline || null,
    restaurantId: restaurantId || null,
    status: 'active',
    createdAt: new Date().toISOString(),
    orders: []
  };

  // Auto-set deadline to 1 hour from now if not provided
  if (!session.deadline) {
    const autoDeadline = new Date(Date.now() + 60 * 60 * 1000);
    session.deadline = autoDeadline.toISOString();
  }
  
  sessions.set(sessionId, session);
  
  res.json({
    sessionId,
    url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/join/${sessionId}`
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const costs = calculateCosts(session);

  // Include restaurant data if session has a restaurant
  let restaurant = null;
  if (session.restaurantId) {
    try {
      const dataFile = path.join(process.cwd(), 'data', 'restaurants.json');
      if (fs.existsSync(dataFile)) {
        const restaurants = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
        restaurant = restaurants.find(r => r.id === session.restaurantId) || null;
      }
    } catch (e) { /* ignore */ }
  }

  res.json({
    ...session,
    costs,
    restaurant,
    summary: {
      totalFood: costs.reduce((sum, c) => sum + c.itemsTotal, 0),
      totalDelivery: session.deliveryFee,
      grandTotal: costs.reduce((sum, c) => sum + c.total, 0)
    }
  });
});

app.post('/api/sessions/:id/orders', (req, res) => {
  const session = sessions.get(req.params.id);
  
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
  
  const { participantName, items } = req.body;
  
  // Input validation
  if (!participantName || typeof participantName !== 'string' || !participantName.trim()) {
    return res.status(400).json({ error: 'Participant name is required' });
  }
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
  const trimmedName = participantName.trim();
  const existingIndex = session.orders.findIndex(
    o => o.participantName === trimmedName
  );
  
  const order = {
    participantName: trimmedName,
    items: items.map(i => ({ name: i.name.trim(), price: i.price, quantity: i.quantity })),
    paymentSent: false,
    submittedAt: new Date().toISOString()
  };
  
  if (existingIndex >= 0) {
    session.orders[existingIndex] = order;
  } else {
    session.orders.push(order);
  }
  
  // Broadcast update to all connected clients
  io.to(req.params.id).emit('session-updated', {
    orders: session.orders,
    costs: calculateCosts(session)
  });
  
  res.json({ success: true });
});

app.patch('/api/sessions/:id/orders/:name/payment', (req, res) => {
  const session = sessions.get(req.params.id);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const order = session.orders.find(o => o.participantName === req.params.name);
  
  if (order) {
    order.paymentSent = req.body.paymentSent;
    
    io.to(req.params.id).emit('session-updated', {
      orders: session.orders,
      costs: calculateCosts(session)
    });
    
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  
  if (session) {
    session.status = 'closed';
    io.to(req.params.id).emit('session-closed');
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Update delivery fee
app.patch('/api/sessions/:id/delivery-fee', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { deliveryFee } = req.body;
  const parsed = parseFloat(deliveryFee);
  if (isNaN(parsed) || parsed < 0) {
    return res.status(400).json({ error: 'Delivery fee must be a non-negative number' });
  }

  session.deliveryFee = parsed;

  io.to(req.params.id).emit('session-updated', {
    orders: session.orders,
    costs: calculateCosts(session),
    deliveryFee: session.deliveryFee
  });

  res.json({ success: true, deliveryFee: parsed });
});

// Delete a participant's order
app.delete('/api/sessions/:id/orders/:name', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const name = decodeURIComponent(req.params.name);
  const idx = session.orders.findIndex(o => o.participantName === name);
  if (idx < 0) return res.status(404).json({ error: 'Order not found' });

  session.orders.splice(idx, 1);

  io.to(req.params.id).emit('session-updated', {
    orders: session.orders,
    costs: calculateCosts(session)
  });

  res.json({ success: true });
});

// Edit a participant's order (host can modify items)
app.put('/api/sessions/:id/orders/:name', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const name = decodeURIComponent(req.params.name);
  const order = session.orders.find(o => o.participantName === name);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

  // Update items — each item can have an `unavailable` flag
  order.items = items.map(i => ({
    name: (i.name || '').trim(),
    price: Number(i.price) || 0,
    quantity: parseInt(i.quantity) || 1,
    unavailable: !!i.unavailable
  })).filter(i => i.name);

  io.to(req.params.id).emit('session-updated', {
    orders: session.orders,
    costs: calculateCosts(session)
  });

  res.json({ success: true });
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

// Auto-cleanup old sessions (older than 48 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    const age = now - new Date(session.createdAt).getTime();
    if (age > 48 * 60 * 60 * 1000) {
      sessions.delete(id);
      console.log(`Deleted old session: ${id}`);
    }
  }
}, 60 * 60 * 1000); // Check every hour

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🍳 Breakfast ordering server running on port ${PORT}`);
});
