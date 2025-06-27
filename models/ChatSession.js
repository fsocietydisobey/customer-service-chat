// models/ChatSession.js
const mongoose = require('mongoose');

const ChatSessionSchema = new mongoose.Schema({
	// Identifier for the customer (can be temporary like a socket ID or a UUID)
	// If customers don't register, this acts as their unique ID for the session.
	// If customers *do* register, this could reference the User model.
	customerId: {
		type: String, // Using String for simplicity if customers are anonymous
		required: true,
	},
	customerName: {
		type: String,
		required: true,
	},
	customerEmail: String, // Optional pre-chat info

	// Reference to the agent handling this session
	agentId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User', // Links to the User model where role is 'agent'
		default: null, // Null until an agent accepts the chat
	},
	agentUsername: String, // To store agent's name for easier display

	status: { // Current status of the chat session
		type: String,
		enum: ['pending', 'in_queue', 'assigned', 'closed'],
		default: 'pending', // Starts as pending, then might go to in_queue or assigned
		required: true,
	},
	topic: String, // Customer's initial issue/topic

	startedAt: {
		type: Date,
		default: Date.now,
	},
	endedAt: Date, // When the chat session was closed
});

module.exports = mongoose.model('ChatSession', ChatSessionSchema);
