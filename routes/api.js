// routes/api.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // For protecting API routes
const User = require('../models/User');
const ChatSession = require('../models/ChatSession');
const Message = require('../models/Message');

// Import auth routes (assuming they are still separate or moved here)
const authRoutes = require('./auth'); // Assuming auth.js is also in routes/
router.use('/auth', authRoutes); // Mount auth routes under /api/auth

// Route to get agent status (e.g., 'available', 'unavailable')
// This API route is now primarily for setting manual status, isOnline is handled by sockets
router.put('/agents/status', authMiddleware, async (req, res) => {
	try {
		const { status } = req.body;
		const agentId = req.user.id; // From JWT payload

		if (!['available', 'unavailable'].includes(status)) {
			return res.status(400).json({ msg: 'Invalid status provided.' });
		}

		// Only update the 'status' enum here. 'isOnline' is managed by socket connections.
		const agent = await User.findByIdAndUpdate(
			agentId,
			{ status: status }, // Removed isOnline: true here
			{ new: true, runValidators: true }
		).select('-password');

		if (!agent) {
			return res.status(404).json({ msg: 'Agent not found' });
		}
		// Note: The socket.js will handle broadcasting this status change if set via socket.on('agent:set_status')
		// If this API is called directly, you'd need to emit a socket event here too.
		// For now, assuming client mostly uses socket.emit('agent:set_status')
		res.json({ msg: `Agent status updated to ${status}`, status: agent.status });
	} catch (error) {
		console.error('Error updating agent status via API:', error);
		res.status(500).send('Server Error');
	}
});

// Route for agents to get pending/active chat sessions
router.get('/chat_sessions', authMiddleware, async (req, res) => {
	try {
		const agentId = req.user.id;
		const sessions = await ChatSession.find({
			$or: [
				{ status: 'in_queue' }, // Queued chats
				{ status: 'pending' }, // Pending chats (if any, though 'in_queue' is usually the first state)
				{ status: 'assigned' }  // All assigned chats, regardless of specific agent
			]
		})
		.sort({ startedAt: 1 })
		.populate({ // Populate agent usernames from the User model
			path: 'agentIds',
			select: 'username'
		});

		// IMPORTANT: Map sessions to ensure agentIds are strings and include agentUsernames for client-side convenience
		const sessionsWithAgentUsernames = sessions.map(session => ({
			...session.toObject(), // Convert Mongoose document to plain JS object
			agentUsernames: session.agentIds.map(agent => agent.username),
			agentIds: session.agentIds.map(agent => agent._id.toString()) // Ensure agent IDs are strings here
		}));

		res.json(sessionsWithAgentUsernames);
	} catch (error) {
		console.error('Error fetching chat sessions via API:', error);
		res.status(500).send('Server Error');
	}
});

// Route to get all agents (excluding current agent) for inviting
router.get('/agents', authMiddleware, async (req, res) => {
	try {
		// Only fetch agents that are currently online and not the requesting agent
		const agents = await User.find({ _id: { $ne: req.user.id }, role: 'agent', isOnline: true }).select('username');
		res.json(agents);
	} catch (error) {
		console.error('Error fetching agents via API:', error);
		res.status(500).send('Server Error');
	}
});

// NEW: Route to get all agents (including current agent) for populating sender usernames in historical messages
// This is added to support fetching agent usernames when `senderUsername` might be missing from old messages
router.get('/agents/all', authMiddleware, async (req, res) => {
	try {
		const agents = await User.find({ role: 'agent' }).select('username');
		res.json(agents);
	} catch (error) {
		console.error('Error fetching all agents via API:', error);
		res.status(500).send('Server Error');
	}
});


// Route to get messages for a specific chat session
router.get('/chat_sessions/:sessionId/messages', authMiddleware, async (req, res) => {
	try {
		const sessionId = req.params.sessionId;
		const agentId = req.user.id; // Agent requesting messages

		const session = await ChatSession.findById(sessionId);
		if (!session) {
			return res.status(404).json({ msg: 'Chat session not found' });
		}

		// Ensure the agent is assigned to this session if it's an 'assigned' chat
		if (session.status === 'assigned' && !session.agentIds.some(id => id.toString() === agentId)) {
			return res.status(403).json({ msg: 'Forbidden: Not assigned to this session' });
		}
		// Also allow messages for 'in_queue' or 'pending' chats for agents (e.g., if they are deciding to pick it up)
		if (session.status !== 'assigned' && session.status !== 'in_queue' && session.status !== 'pending') {
			return res.status(403).json({ msg: 'Forbidden: Chat session is not active or in queue' });
		}


		const messages = await Message.find({ chatSession: sessionId }).sort({ timestamp: 1 });
		res.json(messages);
	} catch (error) {
		console.error('Error fetching session messages via API:', error);
		res.status(500).send('Server Error');
	}
});

module.exports = router;