import express from 'express';
import amqp from 'amqplib';
import pg from 'pg';
import os from 'node:os';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT ?? 3000);
const inventoryUrl = process.env.INVENTORY_URL ?? 'http://localhost:8000';
const queueName = 'order.created';
const pool = new Pool();
let rabbitChannel;

app.use(express.json());

async function connectRabbit() {
  while (!rabbitChannel) {
    try {
      const connection = await amqp.connect(process.env.AMQP_URL);
      rabbitChannel = await connection.createConfirmChannel();
      await rabbitChannel.assertQueue(queueName, { durable: true });
      connection.on('close', () => {
        rabbitChannel = undefined;
      });
    } catch (error) {
      console.error('RabbitMQ indisponivel; nova tentativa em 3s:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return rabbitChannel;
}

async function initializeDatabase() {
  while (true) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id BIGSERIAL PRIMARY KEY,
          sku TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          customer TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      return;
    } catch (error) {
      console.error('PostgreSQL indisponivel; nova tentativa em 3s:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

await initializeDatabase();
connectRabbit();

app.get('/health', (_request, response) => response.json({ status: 'ok' }));

app.get('/api/orders', async (_request, response, next) => {
  try {
    const result = await pool.query('SELECT id, sku, quantity, customer, created_at FROM orders ORDER BY id DESC');
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders', async (request, response, next) => {
  const { sku, quantity, customer } = request.body ?? {};
  if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || typeof customer !== 'string' || !customer.trim()) {
    return response.status(400).json({ error: 'sku, quantity positivo e customer sao obrigatorios' });
  }

  try {
    const reservation = await fetch(`${inventoryUrl}/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku, quantity })
    });
    const inventory = await reservation.json();
    if (!reservation.ok) {
      return response.status(reservation.status).json(inventory);
    }

    const result = await pool.query(
      'INSERT INTO orders (sku, quantity, customer) VALUES ($1, $2, $3) RETURNING id, sku, quantity, customer, created_at',
      [sku, quantity, customer.trim()]
    );
    const order = result.rows[0];
    const channel = await connectRabbit();
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(order)), { persistent: true });
    await channel.waitForConfirms();

    response.status(201).json({
      ...order,
      inventory_pod: inventory.served_by,
      orders_pod: os.hostname(),
      event: queueName
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'erro interno no servico de pedidos' });
});

app.listen(port, '0.0.0.0', () => console.log(`orders-service ouvindo na porta ${port}`));