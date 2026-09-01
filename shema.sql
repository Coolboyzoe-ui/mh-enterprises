-- 1. Create Users Table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  phone VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create Orders Table with Cascade Rules
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  payment_code VARCHAR(20) UNIQUE NOT NULL,
  client_name VARCHAR(150) NOT NULL,
  client_phone VARCHAR(50) NOT NULL,
  store_platform VARCHAR(50) NOT NULL,
  item_url TEXT NOT NULL,
  estimated_price NUMERIC(10, 2) NOT NULL,
  shipping_option VARCHAR(50) DEFAULT 'Air Cargo',
  status VARCHAR(50) DEFAULT 'PENDING_PHYSICAL_PAYMENT',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  paid_at TIMESTAMP WITH TIME ZONE,
  processed_by VARCHAR(50)
);

-- 3. Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_orders_payment_code ON orders (payment_code);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);