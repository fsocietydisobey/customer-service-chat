// socket.js
const User = require('./models/User');
const ChatSession = require('./models/ChatSession');
const Message = require('./models/Message');
const mongoose = require('mongoose'); // Import mongoose to use Types.ObjectId

// In-memory data structures for managing connections and queues
let customerQueue = []; // Array of { customerSocketId, sessionId, customerId, customerName, customerEmail, topic }
const customerSockets = new Map(); // customerId -> socket.id (for anonymous customers)
const agentSockets = new Map(); // agentId -> Set of socket.ids (for agents, allowing multiple tabs)
const agentOfflineTimeouts = new Map(); // agentId -> setTimeoutId for grace period disconnects

// Helper function to find an available agent
const findAvailableAgent = async () => {
	const availableAgent = await User.findOne({
		role: 'agent',
		status: 'available',
		isOnline: true // Must be online and available
	});
	return availableAgent;
};

// Helper to update agent status based on active chats
const updateAgentStatusBasedOnChats = async (io, agentId) => { // Pass io instance
	// Ensure agentId is an ObjectId for Mongoose query
	const objectAgentId = new mongoose.Types.ObjectId(agentId);

	const activeAssignedChatsCount = await ChatSession.countDocuments({
		agentIds: objectAgentId, // Check if agentId is in the agentIds array
		status: 'assigned'
	});

	const currentAgent = await User.findById(agentId);
	if (!currentAgent) return;

	let newStatus = currentAgent.status;
	// Only change to 'chatting' if they are online and have active assigned chats
	if (activeAssignedChatsCount > 0 && currentAgent.isOnline && currentAgent.status !== 'chatting') {
		newStatus = 'chatting';
	} else if (activeAssignedChatsCount === 0 && currentAgent.status === 'chatting' && currentAgent.isOnline) {
		newStatus = 'available'; // If they were chatting but now have no active assigned chats, and are online
	}
	// If they are offline, their status should be 'unavailable' regardless of chats.
	// This is handled by the disconnect logic.

	if (newStatus !== currentAgent.status) {
		await User.findByIdAndUpdate(agentId, {status: newStatus});
		io.to('agents').emit('agent:status_updated', {userId: agentId, status: newStatus});
		console.log(`[Status Update Helper] Agent ${currentAgent.username} (${agentId}) status updated to: ${newStatus}`);
	}
};


module.exports = (io) => { // Export a function that takes the io instance
	io.on('connection', (socket) => {
		console.log(`New connection: ${socket.id}`);

		// --- Customer Side Events ---
		socket.on('customer:request_chat', async ({customerName, customerEmail, topic}) => {
			console.log(`[Customer Request] Customer ${customerName} requesting chat.`);
			// Generate a unique customerId for this session, linking to their browser session
			const customerId = `customer_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			socket.customerId = customerId; // Attach to socket for easy lookup
			customerSockets.set(customerId, socket.id); // Map customerId to current socket.id

			let session;
			let assignedAgent = await findAvailableAgent();

			if (assignedAgent) {
				session = new ChatSession({
					customerId,
					customerName,
					customerEmail,
					topic,
					agentIds: [assignedAgent._id], // Store as array of ObjectIds
					status: 'assigned',
				});
				await session.save();
				console.log(`[Customer Request] New session ${session._id} created with initial agent: ${assignedAgent.username}`);

				// Save customer's initial message to DB
				const initialMessage = new Message({
					chatSession: session._id,
					senderId: customerId,
					senderRole: 'customer',
					content: topic, // Use the topic as the initial message content
				});
				await initialMessage.save();
				console.log(`[Customer Request] Initial message saved for session ${session._id}: "${topic}"`);

				// Update agent's status (e.g., to 'chatting')
				await updateAgentStatusBasedOnChats(io, assignedAgent._id.toString());

				// Customer's socket joins the room immediately upon session creation
				socket.join(session._id.toString());
				console.log(`[Customer Request] Customer socket ${socket.id} joined room ${session._id.toString()}.`);

				// Populate agent usernames for the customer's client
				const populatedSession = await ChatSession.findById(session._id)
				.populate({ path: 'agentIds', select: 'username' });
				const agentUsernames = populatedSession.agentIds.map(agent => agent.username);
				const agentIdsStrings = populatedSession.agentIds.map(agent => agent._id.toString()); // Convert to string here


				socket.emit('chat:assigned', {
					sessionId: session._id,
					agentNames: agentUsernames,
					customerId: customerId
				});
				console.log(`[Customer Request] Emitted chat:assigned to customer ${customerId} with agentNames: ${agentUsernames}`);

				// Notify the assigned agent
				if (agentSockets.has(assignedAgent._id.toString())) {
					agentSockets.get(assignedAgent._id.toString()).forEach(agentSocketId => {
						io.to(agentSocketId).emit('agent:chat_assigned_to_me', {
							sessionId: session._id,
							customerName: customerName,
							topic: topic
						});
						// Ensure the specific agent socket joins the chat room
						io.sockets.sockets.get(agentSocketId)?.join(session._id.toString());
						console.log(`[Customer Request] Emitted agent:chat_assigned_to_me to agent socket ${agentSocketId}`);
					});
				}
				console.log(`Chat session ${session._id} assigned to agent ${assignedAgent.username}`);

				// Broadcast to all agents that a session's status changed
				io.to('agents').emit('agent:session_status_changed', {
					sessionId: session._id,
					newStatus: 'assigned',
					agentIds: agentIdsStrings, // Send stringified IDs
					agentUsernames: agentUsernames
				});
				console.log(`[Customer Request] Broadcast agent:session_status_changed to all agents for session ${session._id}`);

				// Emit the initial message back to the customer and agent in the chat room
				io.to(session._id.toString()).emit('chat:message', {
					sessionId: session._id.toString(),
					senderId: initialMessage.senderId,
					senderRole: initialMessage.senderRole,
					content: initialMessage.content,
					timestamp: initialMessage.timestamp,
					senderUsername: customerName // Customer's name as sender
				});

			} else {
				session = new ChatSession({
					customerId,
					customerName,
					customerEmail,
					topic,
					status: 'in_queue',
				});
				await session.save();
				customerQueue.push({
					customerSocketId: socket.id,
					sessionId: session._id.toString(), // Store as string for consistency
					customerId,
					customerName,
					customerEmail,
					topic
				});
				console.log(`[Customer Request] No agent available. Session ${session._id} added to queue.`);

				// Save customer's initial message to DB even if queued
				const initialMessage = new Message({
					chatSession: session._id,
					senderId: customerId,
					senderRole: 'customer',
					content: topic,
				});
				await initialMessage.save();
				console.log(`[Customer Request] Initial message saved for queued session ${session._id}: "${topic}"`);

				// Customer's socket joins the room immediately upon session creation, even if queued
				socket.join(session._id.toString());
				console.log(`[Customer Request] Customer socket ${socket.id} joined room ${session._id.toString()} (queued).`);

				socket.emit('chat:queued', {
					position: customerQueue.length,
					sessionId: session._id.toString(),
					customerId: customerId
				});
				console.log(`[Customer Request] Emitted chat:queued to customer ${customerId}`);

				io.to('agents').emit('agent:new_queue_item', {sessionId: session._id.toString(), customerName});
				console.log(`[Customer Request] Broadcast agent:new_queue_item to all agents for session ${session._id}`);

				// Emit the initial message back to the customer (even if queued)
				io.to(session._id.toString()).emit('chat:message', {
					sessionId: session._id.toString(),
					senderId: initialMessage.senderId,
					senderRole: initialMessage.senderRole,
					content: initialMessage.content,
					timestamp: initialMessage.timestamp,
					senderUsername: customerName // Customer's name as sender
				});
			}
		});

		socket.on('customer:message', async ({sessionId, content}) => {
			console.log(`[Customer Message] Received message for session ${sessionId} from customer ${socket.customerId}: ${content}`);
			if (!socket.customerId || !sessionId) {
				console.warn('[Customer Message] Missing customerId or sessionId.');
				return;
			}

			try {
				const chatSession = await ChatSession.findById(sessionId);

				// Allow messages if status is 'in_queue' (for initial message only), 'assigned'
				if (!chatSession || chatSession.customerId !== socket.customerId || !(chatSession.status === 'assigned' || (chatSession.status === 'in_queue' && chatSession.topic === content))) { // Only allow topic message if in queue
					console.warn(`[Customer Message] Customer ${socket.customerId} tried to send message to invalid/unassigned/non-active session ${sessionId} (status: ${chatSession?.status}).`);
					return;
				}

				const newMessage = new Message({
					chatSession: sessionId,
					senderId: socket.customerId,
					senderRole: 'customer',
					content,
				});
				await newMessage.save();
				console.log(`[Customer Message] Message saved: ${newMessage._id}`);

				io.to(sessionId).emit('chat:message', {
					sessionId,
					senderId: socket.customerId,
					senderRole: 'customer',
					content,
					timestamp: newMessage.timestamp,
					senderUsername: chatSession.customerName // Include sender's username
				});
				console.log(`[Customer Message] Emitted chat:message to room ${sessionId}`);

			} catch (error) {
				console.error('[Customer Message] Error saving customer message:', error);
			}
		});

		socket.on('customer:close_chat_request', async ({sessionId}) => {
			console.log(`[Customer Close] Customer ${socket.customerId} requesting to close session ${sessionId}`);
			if (!socket.customerId || !sessionId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);

				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status === 'closed') {
					console.warn(`[Customer Close] Customer ${socket.customerId} tried to close invalid/already closed session ${sessionId}`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();
				console.log(`[Customer Close] Session ${sessionId} status updated to closed.`);


				// Get list of agents in chat for status update
				const agentIdsInChat = chatSession.agentIds.map(id => id.toString());

				const socketsInRoom = await io.in(sessionId).fetchSockets();
				socketsInRoom.forEach(s => {
					s.leave(sessionId);
					s.emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_closed'});
				});
				console.log(`[Customer Close] Emitted chat:session_closed to room ${sessionId} and customer.`);

				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});
				console.log(`[Customer Close] Broadcast agent:session_closed_broadcast for ${sessionId}`);


				for (const agentId of agentIdsInChat) {
					await updateAgentStatusBasedOnChats(io, agentId);
				}

				console.log(`Chat session ${sessionId} closed by customer ${socket.customerId}`);
				customerSockets.delete(chatSession.customerId);

			} catch (error) {
				console.error('[Customer Close] Error closing chat session by customer:', error);
			}
		});

		socket.on('customer:cancel_queue', async ({sessionId}) => {
			console.log(`[Customer Cancel Queue] Customer ${socket.customerId} cancelling queue for session ${sessionId}`);
			if (!socket.customerId || !sessionId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);

				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status !== 'in_queue') {
					console.warn(`[Customer Cancel Queue] Customer ${socket.customerId} tried to cancel invalid/not-in-queue session ${sessionId}`);
					return;
				}

				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.sessionId.toString() !== sessionId);
				if (customerQueue.length < initialQueueLength) {
					io.to('agents').emit('agent:queue_updated', {}); // Notify agents queue changed
					console.log(`[Customer Cancel Queue] Broadcast agent:queue_updated`);
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();
				console.log(`[Customer Cancel Queue] Session ${sessionId} status updated to closed.`);


				socket.emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_cancelled_queue'});
				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});
				console.log(`[Customer Cancel Queue] Emitted chat:session_closed and agent:session_closed_broadcast for ${sessionId}`);

				customerSockets.delete(chatSession.customerId);

				console.log(`Customer ${socket.customerId} cancelled chat request ${sessionId} from queue.`);

			} catch (error) {
				console.error('[Customer Cancel Queue] Error cancelling queued chat:', error);
			}
		});

		socket.on('customer:rejoin_chat', async ({ sessionId, customerId }) => {
			console.log(`[Customer Rejoin] Customer ${customerId} attempting to rejoin session ${sessionId}`);
			if (!sessionId || !customerId) {
				console.warn('[Customer Rejoin] Missing sessionId or customerId for rejoin.');
				return;
			}

			try {
				const chatSession = await ChatSession.findById(sessionId);

				if (!chatSession || chatSession.customerId !== customerId || !(chatSession.status === 'assigned' || chatSession.status === 'in_queue')) {
					console.warn(`[Customer Rejoin] Rejoin failed for session ${sessionId}. Not found, invalid customer, or status not active (${chatSession?.status}).`);
					socket.emit('chat:session_closed', { sessionId, reason: 'rejoin_failed' });
					return;
				}

				// Update the customer's current socket.id mapping
				customerSockets.set(customerId, socket.id);
				socket.customerId = customerId; // Ensure socket has customerId property

				// Have the new socket join the room
				socket.join(sessionId);
				console.log(`[Customer Rejoin] Customer socket ${socket.id} joined room ${sessionId}.`);

				// Resend chat assignment/queue info
				if (chatSession.status === 'assigned') {
					const populatedSession = await ChatSession.findById(sessionId)
					.populate({ path: 'agentIds', select: 'username' });
					const agentUsernames = populatedSession.agentIds.map(agent => agent.username);
					socket.emit('chat:assigned', {
						sessionId,
						agentNames: agentUsernames,
						customerId
					});
					console.log(`[Customer Rejoin] Emitted chat:assigned to rejoining customer ${customerId}`);
				} else if (chatSession.status === 'in_queue') {
					const queueItem = customerQueue.find(item => item.sessionId === sessionId);
					socket.emit('chat:queued', {
						position: queueItem ? customerQueue.indexOf(queueItem) + 1 : 1,
						sessionId,
						customerId
					});
					console.log(`[Customer Rejoin] Emitted chat:queued to rejoining customer ${customerId}`);
				}

				// Send recent messages
				const messages = await Message.find({ chatSession: sessionId }).sort({ timestamp: 1 });
				messages.forEach(msg => {
					let senderUsername;
					if (msg.senderRole === 'customer') {
						senderUsername = chatSession.customerName;
					} else if (msg.senderRole === 'agent') {
						// For agents, we might need to fetch their username if not available in Message directly
						// Or, better, the client script handles this using senderId and its own sessionDataMap
						senderUsername = 'Agent'; // Placeholder, client will resolve
					}
					socket.emit('chat:message', {
						sessionId: msg.chatSession.toString(),
						senderId: msg.senderId,
						senderRole: msg.senderRole,
						content: msg.content,
						timestamp: msg.timestamp,
						senderUsername: senderUsername // Client will refine this
					});
				});
				console.log(`[Customer Rejoin] Sent ${messages.length} historical messages to rejoining customer.`);

			} catch (error) {
				console.error('[Customer Rejoin] Error rejoining customer chat:', error);
				socket.emit('chat:session_closed', { sessionId, reason: 'rejoin_error' });
			}
		});

		// --- Agent Side Events ---
		socket.on('agent:authenticate', async (agentId) => {
			console.log(`[Agent Auth] Agent ${agentId} attempting to authenticate.`);
			if (!agentId) {
				socket.emit('auth_error', 'Agent ID missing.');
				return;
			}
			socket.agentId = agentId;
			socket.join('agents'); // All agents join a common 'agents' room

			// Clear any pending offline timeout for this agent
			if (agentOfflineTimeouts.has(agentId)) {
				clearTimeout(agentOfflineTimeouts.get(agentId));
				agentOfflineTimeouts.delete(agentId);
				console.log(`[Agent Auth] Cleared offline timeout for agent ${agentId}`);
			}

			if (!agentSockets.has(agentId)) {
				agentSockets.set(agentId, new Set());
			}
			agentSockets.get(agentId).add(socket.id);
			console.log(`[Agent Auth] Agent ${agentId} sockets: ${agentSockets.get(agentId).size}`);


			const agent = await User.findById(agentId);
			if (agent) {
				await User.findByIdAndUpdate(agentId, {isOnline: true});
				console.log(`[Agent Auth] Agent ${agent.username} (${agentId}) authenticated with socket ${socket.id}`);

				const pendingAndAssignedChats = await ChatSession.find({
					$or: [
						{status: 'in_queue'},
						{agentIds: new mongoose.Types.ObjectId(agentId), status: 'assigned'} // Assigned specifically to this agent
					]
				})
				.sort({startedAt: 1})
				.populate({ // Populate agent details to send correct usernames
					path: 'agentIds',
					select: 'username'
				});

				// Filter for assigned chats where this agent is involved and join rooms
				pendingAndAssignedChats.filter(s =>
					s.status === 'assigned' &&
					s.agentIds &&
					s.agentIds.some(aid => aid._id.toString() === agentId) // Check if this agent is in agentIds
				).forEach(s => {
					socket.join(s._id.toString());
					console.log(`[Agent Auth] Agent ${agent.username} joined room ${s._id.toString()} for assigned chat.`);
				});

				// Prepare sessions data with agent usernames and stringified agentIds for the dashboard
				const sessionsForDashboard = pendingAndAssignedChats.map(session => ({
					...session.toObject(), // Convert Mongoose document to plain object
					agentUsernames: session.agentIds.map(a => a.username), // Extract usernames
					agentIds: session.agentIds.map(a => a._id.toString()) // <-- Stringify agentIds here for client
				}));

				socket.emit('agent:initial_dashboard_data', {
					pendingAndAssignedChats: sessionsForDashboard,
					agentStatus: agent.status
				});
				console.log(`[Agent Auth] Emitted agent:initial_dashboard_data to agent ${agent.username}`);

				io.to('agents').emit('agent:online_status', {userId: agent.id, isOnline: true, status: agent.status});
				console.log(`[Agent Auth] Broadcast agent:online_status for ${agent.username}`);

			} else {
				console.warn(`[Agent Auth] Attempted authentication for non-existent agent ID: ${agentId}`);
				socket.emit('auth_error', 'Invalid agent ID');
			}
		});

		socket.on('agent:set_status', async ({status}) => {
			console.log(`[Agent Set Status] Agent ${socket.agentId} attempting to set status to: ${status}`);
			if (!socket.agentId) return;
			try {
				const agent = await User.findByIdAndUpdate(
					socket.agentId,
					{status: status},
					{new: true, runValidators: true}
				);

				if (agent) {
					console.log(`[Agent Set Status] Agent ${agent.username} status updated in DB to: ${status}`);
					if (status === 'available' && customerQueue.length > 0) {
						const nextInQueue = customerQueue.shift();
						const session = await ChatSession.findById(nextInQueue.sessionId);

						if (session && session.status === 'in_queue') {
							session.agentIds.push(agent._id); // Push ObjectId
							session.status = 'assigned';
							await session.save();
							console.log(`[Agent Set Status] Assigned queued session ${session._id} to agent ${agent.username}`);

							await updateAgentStatusBasedOnChats(io, agent._id.toString());

							const populatedSession = await ChatSession.findById(session._id)
							.populate({ path: 'agentIds', select: 'username' });
							const agentUsernames = populatedSession.agentIds.map(a => a.username);
							const agentIdsStrings = populatedSession.agentIds.map(a => a._id.toString()); // Stringify IDs


							const customerSocketId = customerSockets.get(session.customerId);
							if (customerSocketId) {
								const customerSock = io.sockets.sockets.get(customerSocketId);
								if (customerSock) {
									customerSock.join(session._id.toString());
									customerSock.emit('chat:assigned', {
										sessionId: session._id.toString(),
										agentNames: agentUsernames,
										customerId: session.customerId
									});
									console.log(`[Agent Set Status] Emitted chat:assigned to customer ${session.customerId}`);
								}
							}

							// Ensure all of agent's sockets join the room
							if (agentSockets.has(agent._id.toString())) {
								agentSockets.get(agent._id.toString()).forEach(agentSocketId => {
									io.sockets.sockets.get(agentSocketId)?.join(session._id.toString());
									console.log(`[Agent Set Status] Agent socket ${agentSocketId} joined room ${session._id.toString()}.`);
								});
							}


							io.to('agents').emit('agent:queue_updated', {sessionId: session._id.toString(), status: 'assigned'});
							console.log(`[Agent Set Status] Broadcast agent:queue_updated`);

							io.to('agents').emit('agent:session_status_changed', {
								sessionId: session._id.toString(),
								newStatus: 'assigned',
								agentIds: agentIdsStrings, // Send stringified IDs
								agentUsernames: agentUsernames
							});
							console.log(`[Agent Set Status] Broadcast agent:session_status_changed for session ${session._id}`);

							// Emit the initial message for the newly assigned chat to both customer and agent
							const initialMessage = await Message.findOne({ chatSession: session._id, senderRole: 'customer' }).sort({ timestamp: 1 });
							if (initialMessage) {
								io.to(session._id.toString()).emit('chat:message', {
									sessionId: session._id.toString(),
									senderId: initialMessage.senderId,
									senderRole: initialMessage.senderRole,
									content: initialMessage.content,
									timestamp: initialMessage.timestamp,
									senderUsername: session.customerName
								});
								console.log(`[Agent Set Status] Emitted initial message for newly assigned session ${session._id}`);
							}

						} else {
							console.warn(`[Agent Set Status] Queued session ${nextInQueue.sessionId} not found or no longer in queue. Skipping.`);
						}
					}
					io.to('agents').emit('agent:status_updated', {userId: agent._id.toString(), status: agent.status});
					console.log(`[Agent Set Status] Broadcast agent:status_updated for agent ${agent.username}`);
				}
			} catch (error) {
				console.error('[Agent Set Status] Error setting agent status:', error);
			}
		});

		socket.on('agent:message', async ({sessionId, content}) => {
			console.log(`[Agent Message] Received message for session ${sessionId} from agent ${socket.agentId}: ${content}`);
			if (!socket.agentId || !sessionId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId).populate({ path: 'agentIds', select: 'username' });

				if (!chatSession || !chatSession.agentIds.some(a => a._id.toString() === socket.agentId) || chatSession.status !== 'assigned') {
					console.warn(`[Agent Message] Agent ${socket.agentId} tried to send message to invalid/unassigned session ${sessionId}`);
					return;
				}

				const newMessage = new Message({
					chatSession: sessionId,
					senderId: socket.agentId,
					senderRole: 'agent',
					content,
				});
				await newMessage.save();
				console.log(`[Agent Message] Message saved: ${newMessage._id}`);

				const sendingAgent = chatSession.agentIds.find(a => a._id.toString() === socket.agentId);
				const senderUsername = sendingAgent ? sendingAgent.username : 'Unknown Agent';

				io.to(sessionId).emit('chat:message', {
					sessionId,
					senderId: socket.agentId,
					senderRole: 'agent',
					content,
					timestamp: newMessage.timestamp,
					senderUsername: senderUsername
				});
				console.log(`[Agent Message] Emitted chat:message to room ${sessionId}`);

			} catch (error) {
				console.error('[Agent Message] Error saving agent message:', error);
			}
		});

		socket.on('agent:join_chat', async ({sessionId}) => {
			console.log(`[Agent Join Chat] Agent ${socket.agentId} attempting to join session ${sessionId}`);
			if (!socket.agentId || !sessionId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession) {
					console.warn(`[Agent Join Chat] Agent ${socket.agentId} tried to join non-existent session ${sessionId}`);
					return;
				}

				// Check if agent is already in the session (by ID string)
				if (chatSession.agentIds.some(aid => aid.toString() === socket.agentId)) {
					console.log(`[Agent Join Chat] Agent ${socket.agentId} already in session ${sessionId}. Just re-joining room.`);
					// Ensure all sockets for this agent join the room
					if (agentSockets.has(socket.agentId)) {
						agentSockets.get(socket.agentId).forEach(agentSocketId => {
							io.sockets.sockets.get(agentSocketId)?.join(sessionId);
						});
					}
					return; // Nothing more to do if already in session
				}

				const agent = await User.findById(socket.agentId);
				if (!agent) {
					console.error(`[Agent Join Chat] Agent ${socket.agentId} not found when joining chat.`);
					return;
				}

				// Handle joining a queued/pending chat
				if (chatSession.status === 'pending' || chatSession.status === 'in_queue') {
					const initialQueueLength = customerQueue.length;
					customerQueue = customerQueue.filter(item => item.sessionId !== sessionId);
					if (customerQueue.length < initialQueueLength) {
						console.log(`[Agent Join Chat] Removed session ${sessionId} from in-memory queue upon agent join.`);
					}

					chatSession.agentIds.push(agent._id); // Add as ObjectId
					chatSession.status = 'assigned';
					await chatSession.save();
					console.log(`[Agent Join Chat] Session ${sessionId} status updated to assigned by agent ${agent.username}.`);

					await updateAgentStatusBasedOnChats(io, socket.agentId);

					// Populate agent usernames for client updates
					const populatedSession = await ChatSession.findById(sessionId)
					.populate({ path: 'agentIds', select: 'username' });
					const agentUsernames = populatedSession.agentIds.map(a => a.username);
					const agentIdsStrings = populatedSession.agentIds.map(a => a._id.toString()); // Stringify IDs

					const customerSocketId = customerSockets.get(chatSession.customerId);
					if (customerSocketId) {
						const customerSock = io.sockets.sockets.get(customerSocketId);
						if (customerSock) {
							customerSock.join(sessionId);
							customerSock.emit('chat:assigned', {
								sessionId: chatSession._id.toString(),
								agentNames: agentUsernames,
								customerId: chatSession.customerId
							});
							console.log(`Customer ${chatSession.customerId} notified of assignment to agent ${agent.username}`);
						}
					}
					io.to('agents').emit('agent:queue_updated', {});
					io.to('agents').emit('agent:session_status_changed', {
						sessionId: chatSession._id.toString(),
						newStatus: 'assigned',
						agentIds: agentIdsStrings, // Send stringified IDs
						agentUsernames: agentUsernames
					});
					console.log(`[Agent Join Chat] Broadcast agent:session_status_changed for session ${sessionId}`);

				} else if (chatSession.status === 'assigned') {
					// Agent joining an already assigned chat (e.g., inviting themselves or joining a collaborative chat)
					chatSession.agentIds.push(agent._id); // Add as ObjectId
					await chatSession.save();
					console.log(`[Agent Join Chat] Agent ${agent.username} added to existing session ${sessionId}.`);

					await updateAgentStatusBasedOnChats(io, socket.agentId);

					// Populate agent usernames for client updates
					const populatedSession = await ChatSession.findById(sessionId)
					.populate({ path: 'agentIds', select: 'username' });
					const agentUsernames = populatedSession.agentIds.map(a => a.username);
					const agentIdsStrings = populatedSession.agentIds.map(a => a._id.toString()); // Stringify IDs

					io.to(sessionId).emit('chat:agent_joined', {
						sessionId: chatSession._id.toString(),
						agentId: agent._id.toString(),
						agentUsername: agent.username,
						allAgentNames: agentUsernames
					});
					console.log(`[Agent Join Chat] Emitted chat:agent_joined to room ${sessionId}`);

					io.to('agents').emit('agent:session_status_changed', {
						sessionId: chatSession._id.toString(),
						newStatus: 'assigned',
						agentIds: agentIdsStrings, // Send stringified IDs
						agentUsernames: agentUsernames
					});
					console.log(`[Agent Join Chat] Broadcast agent:session_status_changed for session ${chatSession._id}`);
				}

				// Ensure all of agent's sockets join the room
				if (agentSockets.has(socket.agentId)) {
					agentSockets.get(socket.agentId).forEach(agentSocketId => {
						io.sockets.sockets.get(agentSocketId)?.join(sessionId);
					});
				}
				console.log(`[Agent Join Chat] Agent socket ${socket.id} joined room ${sessionId}.`);

			} catch (error) {
				console.error('[Agent Join Chat] Error agent joining chat session:', error);
			}
		});

		socket.on('agent:invite_agent', async ({sessionId, invitedAgentId}) => {
			console.log(`[Agent Invite] Agent ${socket.agentId} inviting ${invitedAgentId} to session ${sessionId}`);
			if (!socket.agentId || !invitedAgentId || !sessionId) {
				console.warn(`[Agent Invite] Missing parameters.`);
				return;
			}

			try {
				const chatSession = await ChatSession.findById(sessionId);

				if (!chatSession || chatSession.status !== 'assigned' || !chatSession.agentIds.some(a => a.toString() === socket.agentId)) {
					console.warn(`[Agent Invite] Agent ${socket.agentId} tried to invite to invalid/unassigned/non-active session ${sessionId}.`);
					return;
				}

				if (chatSession.agentIds.some(aid => aid.toString() === invitedAgentId)) {
					console.log(`[Agent Invite] Invited agent ${invitedAgentId} is already in session ${sessionId}. Skipping.`);
					return;
				}

				const invitedAgentUser = await User.findById(invitedAgentId);
				if (!invitedAgentUser || invitedAgentUser.role !== 'agent') {
					console.warn(`[Agent Invite] Invited ID ${invitedAgentId} is not a valid agent.`);
					return;
				}

				chatSession.agentIds.push(invitedAgentUser._id); // Add as ObjectId
				await chatSession.save();
				console.log(`[Agent Invite] Invited agent ${invitedAgentUser.username} added to session ${sessionId}.`);

				await updateAgentStatusBasedOnChats(io, invitedAgentUser._id.toString());

				const invitingAgentUser = await User.findById(socket.agentId);
				const invitingAgentUsername = invitingAgentUser ? invitingAgentUser.username : 'Another Agent';

				// Populate agent usernames for client updates
				const populatedSession = await ChatSession.findById(sessionId)
				.populate({ path: 'agentIds', select: 'username' });
				const allAgentUsernames = populatedSession.agentIds.map(a => a.username);
				const allAgentIds = populatedSession.agentIds.map(a => a._id.toString()); // Stringify IDs


				if (agentSockets.has(invitedAgentId)) {
					agentSockets.get(invitedAgentId).forEach(agentSocketId => {
						io.sockets.sockets.get(agentSocketId)?.join(sessionId);
						console.log(`[Agent Invite] Invited agent socket ${agentSocketId} joined room ${sessionId}.`);
						io.to(agentSocketId).emit('agent:you_were_invited', {
							sessionId: chatSession._id.toString(),
							customerName: chatSession.customerName,
							topic: chatSession.topic,
							invitingAgentUsername: invitingAgentUsername,
							agentIds: allAgentIds, // Send stringified agent IDs
							agentUsernames: allAgentUsernames // Send all agent usernames
						});
						console.log(`[Agent Invite] Emitted agent:you_were_invited to invited agent socket ${agentSocketId}`);
					});
				}

				io.to(sessionId).emit('chat:agent_joined', {
					sessionId: chatSession._id.toString(),
					agentId: invitedAgentUser._id.toString(),
					agentUsername: invitedAgentUser.username,
					allAgentNames: allAgentUsernames
				});
				console.log(`[Agent Invite] Emitted chat:agent_joined to room ${sessionId}`);

				io.to('agents').emit('agent:session_status_changed', {
					sessionId: chatSession._id.toString(),
					newStatus: 'assigned',
					agentIds: allAgentIds, // Send stringified IDs
					agentUsernames: allAgentUsernames
				});
				console.log(`[Agent Invite] Broadcast agent:session_status_changed for session ${chatSession._id}`);

				console.log(`Agent ${invitedAgentUser.username} invited to session ${sessionId} by ${socket.agentId}.`);

			} catch (error) {
				console.error('[Agent Invite] Error inviting agent to chat session:', error);
			}
		});

		socket.on('agent:leave_chat', async ({sessionId}) => {
			console.log(`[Agent Leave Chat] Agent ${socket.agentId} attempting to leave session ${sessionId}`);
			if (!socket.agentId || !sessionId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId).populate({ path: 'agentIds', select: 'username' });
				if (!chatSession || chatSession.status === 'closed') {
					console.warn(`[Agent Leave Chat] Agent ${socket.agentId} tried to leave invalid/closed session ${sessionId}`);
					return;
				}

				const agentIndex = chatSession.agentIds.findIndex(a => a._id.toString() === socket.agentId);
				let leavingAgentUsername = 'Unknown Agent';
				if (agentIndex > -1) {
					leavingAgentUsername = chatSession.agentIds[agentIndex].username;
					chatSession.agentIds.splice(agentIndex, 1); // Remove the ObjectId
				} else {
					console.warn(`[Agent Leave Chat] Agent ${socket.agentId} not found in session ${sessionId} to leave.`);
					return;
				}

				// Update agent's status based on their remaining chats
				await updateAgentStatusBasedOnChats(io, socket.agentId);

				// Prepare updated agent usernames and stringified IDs for broadcast
				const updatedAgentUsernames = chatSession.agentIds.map(a => a.username);
				const updatedAgentIds = chatSession.agentIds.map(a => a._id.toString()); // Stringify IDs


				if (chatSession.agentIds.length === 0) {
					// Last agent left
					chatSession.status = 'closed';
					chatSession.endedAt = Date.now();
					await chatSession.save();
					console.log(`[Agent Leave Chat] Session ${sessionId} closed as last agent left.`);

					const socketsInRoom = await io.in(sessionId).fetchSockets();
					socketsInRoom.forEach(s => {
						s.leave(sessionId);
						s.emit('chat:session_closed', {sessionId: sessionId, reason: 'agent_left_last'});
					});
					io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});
					customerSockets.delete(chatSession.customerId);
					console.log(`Chat session ${sessionId} closed due to last agent (${socket.agentId}) leaving.`);

				} else {
					// Other agents remain
					await chatSession.save();
					console.log(`[Agent Leave Chat] Session ${sessionId} updated after agent left.`);
					io.to(sessionId).emit('chat:agent_left', {
						sessionId: chatSession._id.toString(),
						agentId: socket.agentId,
						agentUsername: leavingAgentUsername,
						allAgentNames: updatedAgentUsernames // Send updated list
					});
					console.log(`[Agent Leave Chat] Emitted chat:agent_left to room ${sessionId}`);

					io.to('agents').emit('agent:session_status_changed', {
						sessionId: chatSession._id.toString(),
						newStatus: 'assigned', // Still assigned
						agentIds: updatedAgentIds, // Send stringified IDs
						agentUsernames: updatedAgentUsernames // Send updated list
					});
					console.log(`[Agent Leave Chat] Broadcast agent:session_status_changed for session ${chatSession._id}`);

				}

				// Only the specific socket that emitted 'leave_chat' leaves the room
				socket.leave(sessionId);
				console.log(`[Agent Leave Chat] Agent socket ${socket.id} left room ${sessionId}.`);


			} catch (error) {
				console.error('[Agent Leave Chat] Error agent leaving chat session:', error);
			}
		});


		socket.on('agent:close_chat', async (sessionId) => {
			console.log(`[Agent Close Chat] Agent ${socket.agentId} attempting to close session ${sessionId}`);
			if (!socket.agentId || !sessionId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);

				if (!chatSession || !chatSession.agentIds.some(a => a.toString() === socket.agentId) || chatSession.status === 'closed') {
					console.warn(`[Agent Close Chat] Agent ${socket.agentId} tried to close invalid/already closed session ${sessionId} or not assigned.`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();
				console.log(`[Agent Close Chat] Session ${sessionId} status updated to closed.`);

				// Get list of agents in chat for status update
				const agentIdsInChat = chatSession.agentIds.map(id => id.toString());

				const socketsInRoom = await io.in(sessionId).fetchSockets();
				socketsInRoom.forEach(s => {
					s.leave(sessionId);
					s.emit('chat:session_closed', {sessionId: sessionId, reason: 'agent_closed'});
				});
				console.log(`[Agent Close Chat] Emitted chat:session_closed to room ${sessionId}`);


				for (const agentId of agentIdsInChat) { // Loop through original agents assigned
					await updateAgentStatusBasedOnChats(io, agentId);
				}

				customerSockets.delete(chatSession.customerId);

				console.log(`Chat session ${sessionId} closed by agent ${socket.agentId}`);
				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});
				console.log(`[Agent Close Chat] Broadcast agent:session_closed_broadcast for ${sessionId}`);

			} catch (error) {
				console.error('[Agent Close Chat] Error closing chat session:', error);
			}
		});


		// --- Disconnection Handling ---
		socket.on('disconnect', async () => {
			console.log(`[Disconnect] Disconnected: ${socket.id}`);

			if (socket.customerId) {
				console.log(`[Disconnect] Customer ${socket.customerId} disconnected.`);
				// Remove from customerSockets map
				// We don't remove from customerQueue here, as queue items are managed by sessionId and customerId
				// A customer disconnects, the socket.id might be recycled, so cleaning up here is direct.
				customerSockets.delete(socket.customerId);

				// Find if this customer had an active (assigned or in_queue) session
				const activeSession = await ChatSession.findOne({customerId: socket.customerId, status: { $in: ['assigned', 'in_queue'] }});

				if (activeSession) {
					// If the customer was in queue, remove them from the in-memory queue
					const initialQueueLength = customerQueue.length;
					customerQueue = customerQueue.filter(item => item.sessionId !== activeSession._id.toString());
					if (customerQueue.length < initialQueueLength) {
						io.to('agents').emit('agent:queue_updated', {});
						console.log(`[Disconnect] Broadcast agent:queue_updated due to customer leaving queue.`);
					}

					activeSession.status = 'closed';
					activeSession.endedAt = Date.now();
					await activeSession.save();
					console.log(`[Disconnect] Session ${activeSession._id} closed due to customer disconnect.`);

					const agentIdsInChat = activeSession.agentIds.map(id => id.toString());

					// Notify everyone in the session room and agents dashboard
					io.to(activeSession._id.toString()).emit('chat:session_closed', {
						sessionId: activeSession._id.toString(),
						reason: 'customer_disconnected'
					});
					io.to('agents').emit('agent:session_closed_broadcast', {sessionId: activeSession._id.toString()});
					console.log(`[Disconnect] Emitted chat:session_closed and agent:session_closed_broadcast for ${activeSession._id}`);

					// Update status for agents who were assigned to this chat
					for (const agentId of agentIdsInChat) {
						await updateAgentStatusBasedOnChats(io, agentId);
					}
				}
			}

			if (socket.agentId) {
				console.log(`[Disconnect] Agent ${socket.agentId} disconnected.`);
				if (agentSockets.has(socket.agentId)) {
					agentSockets.get(socket.agentId).delete(socket.id);

					if (agentSockets.get(socket.agentId).size === 0) {
						// No active sockets left for this agent, start grace period
						console.log(`[Disconnect] Agent ${socket.agentId} has no active sockets. Starting offline timer...`);
						const timeoutId = setTimeout(async () => {
							// This code runs ONLY if the agent hasn't reconnected within the timeout
							if (!agentSockets.has(socket.agentId) || agentSockets.get(socket.agentId).size === 0) {
								agentSockets.delete(socket.agentId); // Ensure it's fully removed
								await User.findByIdAndUpdate(socket.agentId, {isOnline: false, status: 'unavailable'});
								io.to('agents').emit('agent:online_status', {
									userId: socket.agentId,
									isOnline: false,
									status: 'unavailable'
								});
								console.log(`[Disconnect Timeout] Agent ${socket.agentId} is now truly offline after timeout.`);

								const assignedChats = await ChatSession.find({agentIds: new mongoose.Types.ObjectId(socket.agentId), status: 'assigned'});
								for (const assignedChat of assignedChats) {
									const agentIndex = assignedChat.agentIds.findIndex(a => a.toString() === socket.agentId);
									if (agentIndex > -1) {
										assignedChat.agentIds.splice(agentIndex, 1);
									}

									if (assignedChat.agentIds.length === 0) {
										// This was the last agent for this chat
										assignedChat.status = 'closed';
										assignedChat.endedAt = Date.now();
										await assignedChat.save();
										io.to(assignedChat._id.toString()).emit('chat:session_closed', {
											sessionId: assignedChat._id.toString(),
											reason: 'agent_disconnected_last'
										});
										io.to('agents').emit('agent:session_closed_broadcast', {sessionId: assignedChat._id.toString()});
										customerSockets.delete(assignedChat.customerId); // Remove customer's socket ID mapping
										console.log(`[Disconnect Timeout] Session ${assignedChat._id} closed due to last agent (${socket.agentId}) disconnect.`);
									} else {
										// Other agents are still in the chat
										// Re-populate to get current usernames for broadcast
										const updatedSession = await ChatSession.findById(assignedChat._id)
										.populate({ path: 'agentIds', select: 'username' });
										const remainingAgentUsernames = updatedSession.agentIds.map(a => a.username);
										const remainingAgentIds = updatedSession.agentIds.map(a => a._id.toString());


										await assignedChat.save(); // Save the modified agentIds
										io.to(assignedChat._id.toString()).emit('chat:agent_left', {
											sessionId: assignedChat._id.toString(),
											agentId: socket.agentId,
											agentUsername: 'Disconnected Agent', // Or fetch from DB if needed
											allAgentNames: remainingAgentUsernames
										});
										io.to('agents').emit('agent:session_status_changed', {
											sessionId: assignedChat._id.toString(),
											newStatus: 'assigned', // Still assigned if other agents are there
											agentIds: remainingAgentIds,
											agentUsernames: remainingAgentUsernames
										});
										console.log(`Agent ${socket.agentId} disconnected from session ${assignedChat._id}. Other agents remaining.`);
									}
								}
							}
							agentOfflineTimeouts.delete(socket.agentId); // Clear timeout map after execution
						}, 5000); // 5-second grace period for reconnection
						agentOfflineTimeouts.set(socket.agentId, timeoutId);
					}
				}
			}
		});
	});
};