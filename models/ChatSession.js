// models/ChatSession.js
const mongoose = require('mongoose');

const ChatSessionSchema = new mongoose.Schema({
	// Identifier for the customer (can be temporary like a socket ID or a UUID)
	customerId: {
		type: String,
		required: true,
		index: true // Add index for efficient lookups
	},
	customerName: {
		type: String,
		required: true,
	},
	customerEmail: String, // Optional pre-chat info

	// MODIFIED: agentIds is an array of ObjectIds (no agentUsernames field here)
	agentIds: [{
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User', // Links to the User model where role is 'agent'
		index: true // Add index for querying sessions by agent
	}],

	status: { // Current status of the chat session
		type: String,
		enum: ['pending', 'in_queue', 'assigned', 'closed'],
		default: 'pending', // Starts as pending, then might go to in_queue or assigned
		required: true,
		index: true // Add index for filtering by status
	},
	topic: String, // Customer's initial issue/topic

	startedAt: {
		type: Date,
		default: Date.now,
		index: true // Add index for sorting by start time
	},
	endedAt: Date, // When the chat session was closed
});

module.exports = mongoose.model('ChatSession', ChatSessionSchema);