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
router.put('/agents/status', authMiddleware, async (req, res) => {
	try {
		const { status } = req.body;
		const agentId = req.user.id; // From JWT payload

		if (!['available', 'unavailable'].includes(status)) {
			return res.status(400).json({ msg: 'Invalid status provided.' });
		}

		const agent = await User.findByIdAndUpdate(
			agentId,
			{ status, isOnline: true },
			{ new: true, runValidators: true }
		).select('-password');

		if (!agent) {
			return res.status(404).json({ msg: 'Agent not found' });
		}
		// Note: Socket.IO broadcast for status update will be handled in socket.js
		// when status is changed via socket event or on agent:set_status.
		// If this API is called directly, we might need a direct socket broadcast here too,
		// but for current flow, it's typically driven by socket.on('agent:set_status').

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
				{ status: 'pending' },
				{ status: 'in_queue' },
				// MODIFIED: Include sessions assigned to *any* agent, not just the current one.
				// This allows all agents to see all active chats.
				{ status: 'assigned' }
			]
		}).sort({ startedAt: 1 });

		res.json(sessions);
	} catch (error) {
		console.error('Error fetching chat sessions via API:', error);
		res.status(500).send('Server Error');
	}
});

// Route to get all agents (excluding current agent) for inviting
router.get('/agents', authMiddleware, async (req, res) => {
	try {
		const agents = await User.find({ _id: { $ne: req.user.id }, role: 'agent' }).select('username');
		res.json(agents);
	} catch (error) {
		console.error('Error fetching agents via API:', error);
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

		// FIXED: Ensure agentIds is an array before checking includes
		session.agentIds = session.agentIds || [];
		if (session.status === 'assigned' && !session.agentIds.includes(agentId)) {
			return res.status(403).json({ msg: 'Forbidden: Not assigned to this session' });
		}

		const messages = await Message.find({ chatSession: sessionId }).sort({ timestamp: 1 });
		res.json(messages);
	} catch (error) {
		console.error('Error fetching session messages via API:', error);
		res.status(500).send('Server Error');
	}
});

module.exports = router;
