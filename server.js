require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api'); // Import API routes

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
// Attach io instance to app
app.set('io', io);
require('./socket')(io);

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes); // Use API routes
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));