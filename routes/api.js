const express = require('express');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');
const ChatSession = require('../models/ChatSession');
const Message = require('../models/Message');
const router = express.Router();

// Route to get agent status (e.g., 'available', 'unavailable')
router.put('/agents/status', authMiddleware, async (req, res) => {
	try {
		const { status } = req.body;
		const agentId = req.user.id; // From JWT payload

		// Validate status
		if (!['available', 'unavailable'].includes(status)) {
			return res.status(400).json({ msg: 'Invalid status provided.' });
		}

		// Update agent's status in DB
		const agent = await User.findByIdAndUpdate(
			agentId,
			{ status, isOnline: true }, // isOnline ensures they are marked online if setting status
			{ new: true, runValidators: true }
		).select('-password');

		if (!agent) {
			return res.status(404).json({ msg: 'Agent not found' });
		}

		// Broadcast the status change to all connected agents for dashboard updates
		req.app.get('io').to('agents').emit('agent:status_updated', { userId: agent.id, status: agent.status });

		res.json({ msg: `Agent status updated to ${status}`, status: agent.status });
	} catch (error) {
		console.error('Error updating agent status:', error);
		res.status(500).send('Server Error');
	}
});

// Route for agents to get pending/active chat sessions
router.get('/chat_sessions', authMiddleware, async (req, res) => {
	try {
		const agentId = req.user.id;
		const sessions = await ChatSession.find({
			$or: [
				{ status: 'pending' }, // All pending sessions
				{ status: 'in_queue' }, // All in-queue sessions
				{ agentId: agentId, status: 'assigned' } // Sessions assigned to this agent
			]
		}).sort({ startedAt: 1 }); // Oldest first

		res.json(sessions);
	} catch (error) {
		console.error('Error fetching chat sessions:', error);
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

		// Ensure the agent is assigned to this session or it's a pending/in_queue session they might pick up
		if (session.status === 'assigned' && session.agentId && session.agentId.toString() !== agentId) {
			return res.status(403).json({ msg: 'Forbidden: Not assigned to this session' });
		}
		// If status is pending/in_queue, any agent can view the pre-chat
		// If it's assigned, only the assigned agent can view it

		const messages = await Message.find({ chatSession: sessionId }).sort({ timestamp: 1 });
		res.json(messages);
	} catch (error) {
		console.error('Error fetching session messages:', error);
		res.status(500).send('Server Error');
	}
});

module.exports = router;