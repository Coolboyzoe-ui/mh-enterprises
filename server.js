const bcrypt = require('bcryptjs');
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Twilio client (Optional: fallback mode if credentials aren't configured yet)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

const twilioClient = (accountSid && authToken) ? twilio(accountSid, authToken) : null;

// Force no browser caching
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://mhenterprises_user:XDRYpuswQNoBq56NaPHCKgSb6WI2CEPm@dpg-daat69h42hec73b4qb20-a.oregon-postgres.render.com/mhenterprises',
  ssl: { rejectUnauthorized: false }
});

// Check Connection & Auto-Create Tables / Auto-Migrate
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failure:', err.stack);
  } else {
    console.log('✅ PostgreSQL Database connected successfully!');
    release();
    initDb();
  }
});

// Auto-create database tables & update schema if missing columns
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        payment_code VARCHAR(50) UNIQUE NOT NULL,
        client_name VARCHAR(255) NOT NULL,
        client_phone VARCHAR(50) NOT NULL,
        store_platform VARCHAR(100) NOT NULL,
        item_url TEXT NOT NULL,
        estimated_price NUMERIC(10, 2) NOT NULL,
        shipping_option VARCHAR(100) DEFAULT 'Air Cargo',
        status VARCHAR(50) DEFAULT 'PENDING_PHYSICAL_PAYMENT',
        processed_by VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE
      );
    `);

    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
    `);

    console.log('✅ Database tables & schema verified successfully!');
  } catch (err) {
    console.error('❌ Error updating database schema:', err);
  }
};

// Helper: Generate unique payment code
function generatePaymentCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = 'MHE-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper: Send background WhatsApp message
async function sendAutomatedWhatsApp(clientPhone, clientName, paymentCode, price, isCompletion = false) {
  if (!twilioClient) {
    console.log('⚠️ Twilio credentials not set. Automated message simulated.');
    return;
  }

  // Format phone number to international format if necessary
  let cleanPhone = clientPhone.replace(/[^0-9]/g, '');
  if (!cleanPhone.startsWith('1') && cleanPhone.length === 10) {
    cleanPhone = `1${cleanPhone}`;
  }

  const messageText = isCompletion
    ? `Hello ${clientName}! Your MH Enterprises order *${paymentCode}* is complete and ready for pickup/delivery. Thank you for choosing us!`
    : `Hello ${clientName}! Your cash payment for order *${paymentCode}* ($${parseFloat(price).toFixed(2)} USD) has been received and confirmed at MH Enterprises. Thank you!`;

  try {
    const response = await twilioClient.messages.create({
      from: twilioWhatsappNumber,
      to: `whatsapp:+${cleanPhone}`,
      body: messageText
    });
    console.log(`✅ Automated WhatsApp message sent to +${cleanPhone}. SID: ${response.sid}`);
  } catch (error) {
    console.error('❌ Error sending WhatsApp message via API:', error);
  }
}

// ----------------------------------------------------
// PAGE ROUTES
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ----------------------------------------------------
// USER AUTHENTICATION & PROFILE ENDPOINTS
// ----------------------------------------------------

// 1. Register User
app.post('/api/users/register', async (req, res) => {
  const { fullName, phone, password } = req.body;
  
  if (!fullName || !phone || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  try {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const query = `
      INSERT INTO users (full_name, phone, password) 
      VALUES ($1, $2, $3) 
      RETURNING id, full_name, phone;
    `;
    const { rows } = await pool.query(query, [fullName.trim(), cleanPhone, hashedPassword]);
    
    return res.status(201).json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('❌ Registration Error:', err);

    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });
    }
    
    return res.status(500).json({ success: false, message: err.message || 'Registration failed.' });
  }
});

// 2. Login User
app.post('/api/users/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Phone and password are required.' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password.' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password.' });
    }

    delete user.password;
    return res.json({ success: true, user });
  } catch (err) {
    console.error('❌ Login Error:', err);
    return res.status(500).json({ success: false, message: 'Login server error.' });
  }
});

// 3. Fetch User Order History
app.get('/api/users/:userId/orders', async (req, res) => {
  const { userId } = req.params;
  try {
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    }

    const { rows } = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [parsedUserId]);
    return res.json({ success: true, orders: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch order history.' });
  }
});

// ----------------------------------------------------
// ORDER & PAYMENT ENDPOINTS
// ----------------------------------------------------

// Create Order
app.post('/api/orders/create', async (req, res) => {
  const { userId, clientName, clientPhone, storePlatform, itemUrl, estimatedPrice, shippingOption } = req.body;

  if (!clientName || !clientPhone || !storePlatform || !itemUrl || !estimatedPrice) {
    return res.status(400).json({ success: false, message: 'All required fields must be filled.' });
  }

  const paymentCode = generatePaymentCode();

  try {
    const parsedUserId = userId ? parseInt(userId, 10) : null;
    const parsedPrice = parseFloat(estimatedPrice);

    if (isNaN(parsedPrice)) {
      return res.status(400).json({ success: false, message: 'Invalid price format.' });
    }

    const query = `
      INSERT INTO orders (user_id, payment_code, client_name, client_phone, store_platform, item_url, estimated_price, shipping_option, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_PHYSICAL_PAYMENT')
      RETURNING *;
    `;
    const values = [
      parsedUserId,
      paymentCode,
      clientName.trim(),
      clientPhone.trim(),
      storePlatform,
      itemUrl.trim(),
      parsedPrice,
      shippingOption || 'Air Cargo'
    ];
    
    const { rows } = await pool.query(query, values);

    return res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: {
        paymentCode: rows[0].payment_code,
        orderId: rows[0].id,
        status: rows[0].status,
        totalToPay: rows[0].estimated_price
      }
    });
  } catch (err) {
    console.error('❌ Order Creation Database Error:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Internal server error creating order.' 
    });
  }
});

// Admin: Search Order Code
app.get('/api/admin/orders/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE payment_code = $1', [code.toUpperCase()]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment code not found.' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error searching order.' });
  }
});

// Admin: Confirm Payment & Auto-Send WhatsApp Message
app.post('/api/admin/verify-payment', async (req, res) => {
  const { paymentCode, agentId } = req.body;

  try {
    const checkQuery = 'SELECT * FROM orders WHERE payment_code = $1';
    const { rows } = await pool.query(checkQuery, [paymentCode.toUpperCase()]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Code not found.' });
    }

    const order = rows[0];
    if (order.status === 'PAID_PROCESSING') {
      return res.status(400).json({ success: false, message: 'This code was already processed.' });
    }

    const updateQuery = `
      UPDATE orders 
      SET status = 'PAID_PROCESSING', paid_at = NOW(), processed_by = $1 
      WHERE payment_code = $2 
      RETURNING *;
    `;
    const updated = await pool.query(updateQuery, [agentId || 'AGENT-MAIN', paymentCode.toUpperCase()]);
    const paidOrder = updated.rows[0];

    // AUTOMATIC WHATSAPP TRANSMISSION (Payment Received)
    sendAutomatedWhatsApp(
      paidOrder.client_phone,
      paidOrder.client_name,
      paidOrder.payment_code,
      paidOrder.estimated_price,
      false
    );

    return res.json({
      success: true,
      message: 'Payment confirmed! Automated confirmation queued for dispatch.',
      data: paidOrder
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error verifying payment.' });
  }
});

// Admin: Complete Order & Send Final Notification
app.post('/api/admin/complete-order', async (req, res) => {
  const { paymentCode, phone } = req.body;

  if (!paymentCode) {
    return res.status(400).json({ success: false, message: 'Payment code is required.' });
  }

  try {
    const updateQuery = `
      UPDATE orders 
      SET status = 'COMPLETED', completed_at = NOW() 
      WHERE payment_code = $1 
      RETURNING *;
    `;
    const { rows } = await pool.query(updateQuery, [paymentCode.toUpperCase()]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order code not found.' });
    }

    const completedOrder = rows[0];
    const targetPhone = phone || completedOrder.client_phone;

    // AUTOMATIC WHATSAPP TRANSMISSION (Order Completed)
    sendAutomatedWhatsApp(
      targetPhone,
      completedOrder.client_name,
      completedOrder.payment_code,
      completedOrder.estimated_price,
      true
    );

    return res.json({
      success: true,
      message: `Order #${paymentCode} marked as COMPLETED and notification sent.`,
      data: completedOrder
    });
  } catch (err) {
    console.error('❌ Complete Order Error:', err);
    return res.status(500).json({ success: false, message: 'Error marking order as complete.' });
  }
});

// Admin: Orders & Revenue Log
app.get('/api/admin/orders-log', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM orders WHERE status IN ('PAID_PROCESSING', 'COMPLETED') ORDER BY created_at DESC"
    );
    
    const totalRevenue = rows.reduce((sum, order) => sum + parseFloat(order.estimated_price || 0), 0);
    
    return res.json({ 
      success: true, 
      count: rows.length,
      totalRevenue: totalRevenue.toFixed(2),
      data: rows 
    });
  } catch (err) {
    console.error('Error fetching order log:', err);
    return res.status(500).json({ success: false, message: 'Database query failed.' });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MH Enterprises Server active on http://localhost:${PORT}`);
});