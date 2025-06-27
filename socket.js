const User = require('./models/User');
const ChatSession = require('./models/ChatSession');
const Message = require('./models/Message');

module.exports = (io) => {
	// --- Socket.IO Logic ---

	// In-memory data structures for managing connections and queues
	let customerQueue = []; // Array of { customerSocketId, sessionId, customerId, customerName, customerEmail, topic }
	const customerSockets = new Map(); // customerId -> socket.id (for anonymous customers)
	const agentSockets = new Map(); // agentId -> Set of socket.ids (for agents, allowing multiple tabs)

	// Helper function to find an available agent
	const findAvailableAgent = async () => {
		const availableAgent = await User.findOne({
			role: 'agent',
			status: 'available',
			isOnline: true // Must be online and available
		});
		return availableAgent;
	};

	io.on('connection', (socket) => {
		console.log(`New connection: ${socket.id}`);

		// --- Customer Side Events ---
		socket.on('customer:request_chat', async ({customerName, customerEmail, topic}) => {
			// Generate a unique customerId for this session (could be a UUID)
			const customerId = `customer_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			socket.customerId = customerId; // Store customerId on socket for easy reference
			customerSockets.set(customerId, socket.id); // Map customerId to their current socket ID

			let session;
			let assignedAgent = await findAvailableAgent();
			console.log('assigned agent', assignedAgent)
			if (assignedAgent) {
				// Agent available, create and assign session
				session = new ChatSession({
					customerId,
					customerName,
					customerEmail,
					topic,
					agentId: assignedAgent._id,
					agentUsername: assignedAgent.username,
					status: 'assigned',
				});
				await session.save();

				// Update agent's status to 'chatting' in DB
				await User.findByIdAndUpdate(assignedAgent._id, {status: 'chatting'});
				io.to('agents').emit('agent:status_updated', {userId: assignedAgent._id, status: 'chatting'});


				// Join the socket to a room specific to this chat session
				socket.join(session._id.toString());
				// Emit to customer that chat is assigned
				// FIXED: Include customerId in the emitted event
				socket.emit('chat:assigned', {
					sessionId: session._id,
					agentName: assignedAgent.username,
					customerId: customerId
				});

				// Notify the assigned agent
				// Find ALL sockets for this agent (as agentSockets map userId to Set of socketIds)
				if (agentSockets.has(assignedAgent._id.toString())) {
					agentSockets.get(assignedAgent._id.toString()).forEach(agentSocketId => {
						io.to(agentSocketId).emit('agent:chat_assigned_to_me', {
							sessionId: session._id,
							customerName: customerName,
							topic: topic
						});
						// Agent's socket joins the session room
						io.sockets.sockets.get(agentSocketId)?.join(session._id.toString());
					});
				}


				console.log(`Chat session ${session._id} assigned to agent ${assignedAgent.username}`);
			} else {
				// No agent available, add to queue
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
					sessionId: session._id,
					customerId,
					customerName,
					customerEmail,
					topic
				});

				// FIXED: Include customerId in the emitted event
				socket.emit('chat:queued', {
					position: customerQueue.length,
					sessionId: session._id,
					customerId: customerId
				});
				console.log(`Customer ${customerName} added to queue. Position: ${customerQueue.length}`);
				// Notify all connected agents about new pending chat request
				io.to('agents').emit('agent:new_queue_item', {sessionId: session._id, customerName});
			}
		});

		// Customer sending message
		socket.on('customer:message', async ({sessionId, content}) => {
			if (!socket.customerId) return; // Must have an active customer session

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Ensure customer is part of this session and it's assigned
				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status !== 'assigned') {
					console.warn(`Customer ${socket.customerId} tried to send message to invalid/unassigned session ${sessionId}`);
					return;
				}

				const newMessage = new Message({
					chatSession: sessionId,
					senderId: socket.customerId, // Customer's unique ID for the session
					senderRole: 'customer',
					content,
				});
				await newMessage.save();

				// Emit message to everyone in the chat session room (customer and agent)
				io.to(sessionId).emit('chat:message', {
					sessionId,
					senderId: socket.customerId,
					senderRole: 'customer',
					content,
					timestamp: newMessage.timestamp,
				});
			} catch (error) {
				console.error('Error saving customer message:', error);
			}
		});

		// Customer decides to end the chat (after it's assigned)
		socket.on('customer:close_chat_request', async ({sessionId}) => {
			if (!socket.customerId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status === 'closed') {
					console.warn(`Customer ${socket.customerId} tried to close invalid/already closed session ${sessionId}`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();

				// Remove customer socket from the session room
				socket.leave(sessionId);
				// Notify agent if assigned
				if (chatSession.agentId) {
					// Find all sockets for the agent and remove them from the room
					if (agentSockets.has(chatSession.agentId.toString())) {
						agentSockets.get(chatSession.agentId.toString()).forEach(agentSocketId => {
							io.sockets.sockets.get(agentSocketId)?.leave(sessionId);
						});
					}
				}

				// Emit to both customer and agent that session is closed
				io.to(sessionId).emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_closed'});
				socket.emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_closed'}); // Ensure customer gets it too
				// Broadcast to all agents for dashboard update
				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});

				// Update agent's status if they were only chatting with this customer
				const activeAssignedChats = await ChatSession.countDocuments({
					agentId: chatSession.agentId,
					status: 'assigned'
				});
				if (activeAssignedChats === 0 && chatSession.agentId) { // Only change status if no other active chats
					await User.findByIdAndUpdate(chatSession.agentId, {status: 'available'});
					io.to('agents').emit('agent:status_updated', {userId: chatSession.agentId, status: 'available'});
				} else if (chatSession.agentId) {
					// Agent might still be chatting with others, keep status as 'chatting'
					io.to('agents').emit('agent:status_updated', {userId: chatSession.agentId, status: 'chatting'});
				}


				console.log(`Chat session ${sessionId} closed by customer ${socket.customerId}`);
				customerSockets.delete(chatSession.customerId); // Remove customer from active map

			} catch (error) {
				console.error('Error closing chat session by customer:', error);
			}
		});

		// Customer cancels their request while in queue
		socket.on('customer:cancel_queue', async ({sessionId}) => {
			if (!socket.customerId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status !== 'in_queue') {
					console.warn(`Customer ${socket.customerId} tried to cancel invalid/not-in-queue session ${sessionId}`);
					return;
				}

				// Remove from in-memory queue
				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.sessionId.toString() !== sessionId);
				if (customerQueue.length < initialQueueLength) {
					io.to('agents').emit('agent:queue_updated', {}); // Notify agents queue changed
					console.log(`Customer ${socket.customerId} removed from in-memory queue on cancel.`);
				}

				// Update session status in DB
				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();

				socket.emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_cancelled_queue'});
				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId}); // Update agents dashboard
				customerSockets.delete(chatSession.customerId);

				console.log(`Customer ${socket.customerId} cancelled chat request ${sessionId} from queue.`);

			} catch (error) {
				console.error('Error cancelling queued chat:', error);
			}
		});


		// --- Agent Side Events ---
		socket.on('agent:authenticate', async (agentId) => {
			socket.agentId = agentId; // Store agentId on socket
			socket.join('agents'); // Agents join a common room for broadcasts

			if (!agentSockets.has(agentId)) {
				agentSockets.set(agentId, new Set());
			}
			agentSockets.get(agentId).add(socket.id);

			// Fetch agent's status from DB and update socket status
			const agent = await User.findById(agentId);
			if (agent) {
				await User.findByIdAndUpdate(agentId, {isOnline: true}); // Mark agent as online
				console.log(`Agent ${agent.username} (${agentId}) authenticated with socket ${socket.id}`);
				// Send initial dashboard data (e.g., pending chats)
				const pendingAndAssignedChats = await ChatSession.find({
					$or: [
						{status: 'in_queue'},
						{agentId: agentId, status: 'assigned'}
					]
				}).sort({startedAt: 1});
				socket.emit('agent:initial_dashboard_data', {
					pendingAndAssignedChats,
					agentStatus: agent.status
				});

				// Join rooms for any already assigned chats
				pendingAndAssignedChats.filter(s => s.status === 'assigned' && s.agentId.toString() === agentId)
				.forEach(s => socket.join(s._id.toString()));

				// Broadcast agent's online status
				io.to('agents').emit('agent:online_status', {userId: agent.id, isOnline: true, status: agent.status});

			} else {
				console.warn(`Attempted authentication for non-existent agent ID: ${agentId}`);
				socket.emit('auth_error', 'Invalid agent ID');
			}
		});

		socket.on('agent:set_status', async ({status}) => {
			if (!socket.agentId) return;
			try {
				const agent = await User.findByIdAndUpdate(
					socket.agentId,
					{status: status},
					{new: true, runValidators: true}
				);

				if (agent) {
					// If agent becomes available and there's a queue, assign a chat
					if (status === 'available' && customerQueue.length > 0) {
						const nextInQueue = customerQueue.shift(); // Get next customer
						const session = await ChatSession.findById(nextInQueue.sessionId);

						if (session && session.status === 'in_queue') { // Ensure session is still in queue
							session.agentId = agent._id;
							session.agentUsername = agent.username;
							session.status = 'assigned';
							await session.save();

							// Update agent's status to chatting in DB
							await User.findByIdAndUpdate(agent._id, {status: 'chatting'});

							// Notify customer
							const customerSocketId = customerSockets.get(session.customerId);
							if (customerSocketId) {
								const customerSock = io.sockets.sockets.get(customerSocketId);
								if (customerSock) {
									customerSock.join(session._id.toString());
									// FIXED: Include customerId in the emitted event
									customerSock.emit('chat:assigned', {
										sessionId: session._id,
										agentName: agent.username,
										customerId: session.customerId
									});
								}
							}

							// Notify this agent and other agents
							socket.join(session._id.toString()); // Agent's current socket joins room
							socket.emit('agent:chat_assigned_to_me', {
								sessionId: session._id,
								customerName: session.customerName,
								topic: session.topic
							});
							io.to('agents').emit('agent:queue_updated', {sessionId: session._id, status: 'assigned'}); // Update other agents dashboard
							io.to('agents').emit('agent:status_updated', {userId: agent._id, status: 'chatting'});

							console.log(`Assigned queued chat ${session._id} to agent ${agent.username}`);
						} else {
							console.warn(`Queued session ${nextInQueue.sessionId} not found or no longer in queue. Skipping.`);
							// If session is no longer valid, try to find next available agent for next queue item
							// (more robust error handling needed here, potentially requeue or remove customer from queue)
						}
					}
					// Broadcast status update to all agents
					io.to('agents').emit('agent:status_updated', {userId: agent._id, status: agent.status});
				}
			} catch (error) {
				console.error('Error setting agent status:', error);
			}
		});

		// Agent sending message
		socket.on('agent:message', async ({sessionId, content}) => {
			if (!socket.agentId) return; // Must have an active agent session

			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession || !chatSession.agentId || chatSession.agentId.toString() !== socket.agentId || chatSession.status !== 'assigned') {
					console.warn(`Agent ${socket.agentId} tried to send message to invalid/unassigned session ${sessionId}`);
					return;
				}

				const newMessage = new Message({
					chatSession: sessionId,
					senderId: socket.agentId,
					senderRole: 'agent',
					content,
				});
				await newMessage.save();

				// Emit message to everyone in the chat session room (customer and agent)
				io.to(sessionId).emit('chat:message', {
					sessionId,
					senderId: socket.agentId,
					senderRole: 'agent',
					content,
					timestamp: newMessage.timestamp,
				});
			} catch (error) {
				console.error('Error saving agent message:', error);
			}
		});

		// NEW: Agent accepts a pending/in_queue chat from the dashboard
		socket.on('agent:accept_chat', async ({sessionId}) => {
			if (!socket.agentId) return; // Must be an authenticated agent

			try {
				const chatSession = await ChatSession.findById(sessionId);

				// 1. Validate session and status
				if (!chatSession || (chatSession.status !== 'pending' && chatSession.status !== 'in_queue')) {
					console.warn(`Agent ${socket.agentId} tried to accept invalid/non-pending session ${sessionId}`);
					return;
				}

				// 2. Remove from in-memory queue if it was there
				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.sessionId.toString() !== sessionId);
				if (customerQueue.length < initialQueueLength) {
					console.log(`Removed session ${sessionId} from in-memory queue upon agent acceptance.`);
				}

				// 3. Assign agent and update session status in DB
				chatSession.agentId = socket.agentId;
				const agent = await User.findById(socket.agentId);
				if (agent) {
					chatSession.agentUsername = agent.username;
				} else {
					console.error(`Agent ${socket.agentId} not found when accepting chat.`);
					return;
				}
				chatSession.status = 'assigned';
				await chatSession.save();

				// 4. Update agent's status to 'chatting' in DB
				await User.findByIdAndUpdate(socket.agentId, {status: 'chatting'});
				io.to('agents').emit('agent:status_updated', {userId: socket.agentId, status: 'chatting'});

				// 5. Join agent's current socket to the chat session room
				socket.join(sessionId);

				// 6. Notify the customer
				const customerSocketId = customerSockets.get(chatSession.customerId);
				if (customerSocketId) {
					const customerSock = io.sockets.sockets.get(customerSocketId);
					if (customerSock) {
						customerSock.join(sessionId); // Customer's socket joins the room
						customerSock.emit('chat:assigned', {
							sessionId: chatSession._id,
							agentName: chatSession.agentUsername,
							customerId: chatSession.customerId // Ensure customer gets their ID
						});
						console.log(`Customer ${chatSession.customerId} notified of assignment to agent ${agent.username}`);
					}
				} else {
					console.warn(`Customer socket not found for session ${sessionId}. Customer might have disconnected.`);
				}

				// 7. Broadcast updates to other agents for dashboard
				io.to('agents').emit('agent:queue_updated', {}); // Signal general queue update
				io.to('agents').emit('agent:session_status_changed', {
					sessionId: chatSession._id,
					newStatus: 'assigned',
					agentId: chatSession.agentId,
					agentUsername: chatSession.agentUsername
				});

				console.log(`Agent ${agent.username} manually accepted chat session ${sessionId}`);

			} catch (error) {
				console.error('Error accepting chat session by agent:', error);
			}
		});


		// Agent closes chat session
		socket.on('agent:close_chat', async (sessionId) => {
			if (!socket.agentId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// FIXED: Added null check for chatSession.agentId
				if (!chatSession || !chatSession.agentId || chatSession.agentId.toString() !== socket.agentId || chatSession.status === 'closed') {
					console.warn(`Agent ${socket.agentId} tried to close invalid/already closed session ${sessionId} or not assigned.`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();

				// FIXED: Use fetchSockets() to get actual socket objects in the room
				const socketsInRoom = await io.in(sessionId).fetchSockets(); // Use io.in(room).fetchSockets()
				socketsInRoom.forEach(s => {
					s.leave(sessionId);
					s.emit('chat:session_closed', {sessionId: sessionId, reason: 'agent_closed'}); // Notify both customer and agent
				});

				// Update agent's status if they are not active in other chats
				const activeAssignedChats = await ChatSession.countDocuments({
					agentId: socket.agentId,
					status: 'assigned'
				});

				if (activeAssignedChats === 0) { // If no more active chats, set agent to available
					await User.findByIdAndUpdate(socket.agentId, {status: 'available'});
					io.to('agents').emit('agent:status_updated', {userId: socket.agentId, status: 'available'});
					// If agent was 'chatting' and now has no chats, they go back to 'available'
				} else {
					// Agent still chatting in other sessions, status remains 'chatting'
					// This broadcast ensures consistency for other agents viewing their status
					io.to('agents').emit('agent:status_updated', {userId: socket.agentId, status: 'chatting'});
				}

				// Remove customer's socket mapping if it was based on this session
				customerSockets.delete(chatSession.customerId);

				console.log(`Chat session ${sessionId} closed by agent ${socket.agentId}`);
				// Inform other agents about the closed session (e.g., remove from their dashboard)
				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});

			} catch (error) {
				console.error('Error closing chat session:', error);
			}
		});


		// --- Disconnection Handling ---
		socket.on('disconnect', async () => {
			console.log(`Disconnected: ${socket.id}`);

			// Handle customer disconnect
			if (socket.customerId) {
				console.log(`Customer ${socket.customerId} disconnected.`);
				// If customer was in queue, remove them
				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.customerSocketId !== socket.id);
				if (customerQueue.length < initialQueueLength) {
					io.to('agents').emit('agent:queue_updated', {}); // Notify agents queue changed
					console.log(`Customer ${socket.customerId} removed from in-memory queue on disconnect.`);
				}

				// If customer was in an active assigned chat, update session status (mark as abandoned)
				const activeSession = await ChatSession.findOne({customerId: socket.customerId, status: 'assigned'});
				if (activeSession) {
					activeSession.status = 'closed'; // Mark as closed due to disconnect
					activeSession.endedAt = Date.now();
					await activeSession.save();
					console.log(`Chat session ${activeSession._id} closed due to customer disconnect.`);
					// Notify agent in that session
					io.to(activeSession._id.toString()).emit('chat:session_closed', {
						sessionId: activeSession._id,
						reason: 'customer_disconnected'
					});
					io.to('agents').emit('agent:session_closed_broadcast', {sessionId: activeSession._id});

					// Update agent's status if they were only chatting with this customer
					const activeAssignedChats = await ChatSession.countDocuments({
						agentId: activeSession.agentId,
						status: 'assigned'
					});
					if (activeAssignedChats === 0 && activeSession.agentId) { // Only change status if no other active chats
						await User.findByIdAndUpdate(activeSession.agentId, {status: 'available'});
						io.to('agents').emit('agent:status_updated', {
							userId: activeSession.agentId,
							status: 'available'
						});
					} else if (activeSession.agentId) {
						io.to('agents').emit('agent:status_updated', {
							userId: activeSession.agentId,
							status: 'chatting'
						});
					}
				}
				customerSockets.delete(socket.customerId); // Remove customer from active map
			}

			// Handle agent disconnect
			if (socket.agentId) {
				console.log(`Agent ${socket.agentId} disconnected.`);
				if (agentSockets.has(socket.agentId)) {
					agentSockets.get(socket.agentId).delete(socket.id);

					// If no more sockets for this agent, mark them offline in DB and broadcast
					if (agentSockets.get(socket.agentId).size === 0) {
						agentSockets.delete(socket.agentId);
						// Set agent's status to unavailable and offline in DB
						await User.findByIdAndUpdate(socket.agentId, {isOnline: false, status: 'unavailable'});
						io.to('agents').emit('agent:online_status', {
							userId: socket.agentId,
							isOnline: false,
							status: 'unavailable'
						});
						console.log(`Agent ${socket.agentId} is now truly offline.`);

						// If agent had assigned chats, re-queue them or mark as abandoned (more complex logic needed)
						// For simplicity, we'll just close them for now.
						const assignedChats = await ChatSession.find({agentId: socket.agentId, status: 'assigned'});
						for (const session of assignedChats) {
							session.status = 'closed';
							session.endedAt = Date.now();
							await session.save();
							io.to(session._id.toString()).emit('chat:session_closed', {
								sessionId: session._id,
								reason: 'agent_disconnected'
							});
							io.to('agents').emit('agent:session_closed_broadcast', {sessionId: session._id});
							console.log(`Session ${session._id} closed due to agent disconnect.`);
						}
					}
				}
			}
		});
	});
}