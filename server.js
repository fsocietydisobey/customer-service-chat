// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const pinoHttp = require('pino-http'); // NEW Import pino-http

const connectDB = require('./config/db');
const apiRoutes = require('./routes/api'); // NEW: Import API routes
const initializeSocketIO = require('./socket'); // NEW: Import Socket.IO initialization

const logger = require('./config/logger'); // New: Import your centralized logger

const app = express();
const server = http.createServer(app);
const io = socketIo(server); // Initialize Socket.IO server

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json()); // For parsing application/json
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

// --- Pino HTTP Middleware ---
// This will attach req.log to every request for contextual logging
app.use(pinoHttp({ logger })); // Pass your logger instance to pino-http

// --- API Routes ---
app.use('/api', apiRoutes); // Use the imported API routes under /api

// --- Socket.IO Initialization ---
initializeSocketIO(io); // Pass the io instance to the socket logic file

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
