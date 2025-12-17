require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows your React Native app to connect
app.use(bodyParser.json()); // Allows parsing JSON data from requests

// Database Connection Configuration (Connecting to Neon)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Neon.tech connections
    }
});

// Test DB Connection on Startup
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log('✅ Connected to Neon PostgreSQL Database Successfully');
    release();
});

// --- API ENDPOINTS ---

// 1. GET /customers
// Retrieve all customers to display on the frontend
app.get('/customers', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM customers');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// 2. POST /payments
// Accept a payment from the user
// 2. POST /payments
// Logic: Record payment AND reduce the EMI due amount
app.post('/payments', async (req, res) => {
    const { account_number, amount } = req.body;

    if (!account_number || !amount) {
        return res.status(400).json({ msg: 'Please provide account number and amount' });
    }

    const client = await pool.connect();

    try {
        // Start a Transaction (Ensures both steps happen, or neither happens)
        await client.query('BEGIN');

        // Step A: Check if customer exists and get current due
        const customerCheck = await client.query('SELECT emi_due FROM customers WHERE account_number = $1', [account_number]);
        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ msg: 'Customer Account not found' });
        }

        const currentDue = parseFloat(customerCheck.rows[0].emi_due);
        
        // Step B: Insert the Payment Record
        const newPayment = await client.query(
            'INSERT INTO payments (customer_account_number, payment_amount, status) VALUES ($1, $2, $3) RETURNING *',
            [account_number, amount, 'SUCCESS']
        );

        // Step C: Update the Customer's Due Amount
        // (If they pay more than due, it goes negative, indicating a surplus/credit)
        const newDue = currentDue - parseFloat(amount);
        await client.query(
            'UPDATE customers SET emi_due = $1 WHERE account_number = $2',
            [newDue, account_number]
        );

        // Commit the transaction
        await client.query('COMMIT');

        res.status(201).json({
            msg: 'Payment Processed & Balance Updated',
            payment: newPayment.rows[0],
            new_balance: newDue
        });

    } catch (err) {
        await client.query('ROLLBACK'); // Undo changes if error occurs
        console.error(err.message);
        res.status(500).json({ error: 'Server Error' });
    } finally {
        client.release();
    }
});

// 3. GET /payments/:account_number
// See payment history for a specific person
app.get('/payments', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM payments ORDER BY payment_date DESC');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.get('/payments/:account_number', async (req, res) => {
    const { account_number } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM payments WHERE customer_account_number = $1 ORDER BY payment_date DESC', 
            [account_number]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// --- NEW ROUTE: Dashboard Analytics ---
app.get('/analytics', async (req, res) => {
    try {
        const client = await pool.connect();

        // 1. Calculate Collected Today (Postgres specific syntax)
        const todayQuery = `
            SELECT SUM(payment_amount) as total 
            FROM payments 
            WHERE payment_date::date = CURRENT_DATE
        `;
        
        // 2. Calculate Total Pending Dues
        const dueQuery = `SELECT SUM(emi_due) as total FROM customers`;

        const todayRes = await client.query(todayQuery);
        const dueRes = await client.query(dueQuery);

        client.release();

        res.json({
            collected_today: todayRes.rows[0].total || 0,
            pending_total: dueRes.rows[0].total || 0
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});