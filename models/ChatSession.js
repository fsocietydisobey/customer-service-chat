// models/ChatSession.js
const mongoose = require('mongoose');

const ChatSessionSchema = new mongoose.Schema({
	// Identifier for the customer (can be temporary like a socket ID or a UUID)
	customerId: {
		type: String,
		required: true,
	},
	customerName: {
		type: String,
		required: true,
	},
	customerEmail: String, // Optional pre-chat info

	// MODIFIED: agentId is now an array of ObjectIds
	agentIds: [{
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User', // Links to the User model where role is 'agent'
	}],
	// MODIFIED: agentUsername is now an array of strings
	agentUsernames: [String],

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
