// models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
	chatSession: { // Reference to the ChatSession this message belongs to
		type: mongoose.Schema.Types.ObjectId,
		ref: 'ChatSession',
		required: true,
	},
	senderId: { // ID of the sender (can be customerId or agentId)
		type: String, // Using String because customerId is String
		required: true,
	},
	senderRole: { // 'customer' or 'agent'
		type: String,
		enum: ['customer', 'agent'],
		required: true,
	},
	content: {
		type: String,
		required: true,
	},
	timestamp: {
		type: Date,
		default: Date.now,
	},
});

module.exports = mongoose.model('Message', MessageSchema);
