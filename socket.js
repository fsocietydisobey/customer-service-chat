// socket.js
const User = require('./models/User');
const ChatSession = require('./models/ChatSession');
const Message = require('./models/Message');

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

// Helper to update agent status based on active chats
const updateAgentStatusBasedOnChats = async (io, agentId) => { // Pass io instance
	const activeAssignedChatsCount = await ChatSession.countDocuments({
		agentIds: agentId, // Check if agentId is in the agentIds array
		status: 'assigned'
	});

	const currentAgent = await User.findById(agentId);
	if (!currentAgent) return;

	let newStatus = currentAgent.status;
	if (activeAssignedChatsCount > 0 && currentAgent.status !== 'chatting') {
		newStatus = 'chatting';
	} else if (activeAssignedChatsCount === 0 && currentAgent.status === 'chatting') {
		newStatus = 'available'; // Or 'unavailable' if they set it manually
	}

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
			const customerId = `customer_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			socket.customerId = customerId;
			customerSockets.set(customerId, socket.id);

			let session;
			let assignedAgent = await findAvailableAgent();

			if (assignedAgent) {
				session = new ChatSession({
					customerId,
					customerName,
					customerEmail,
					topic,
					agentIds: [assignedAgent._id], // Store as array
					agentUsernames: [assignedAgent.username], // Store as array
					status: 'assigned',
				});
				// Ensure arrays are initialized even if Mongoose acts weirdly
				session.agentIds = session.agentIds || [];
				session.agentUsernames = session.agentUsernames || [];

				await session.save();
				console.log(`[Customer Request] New session ${session._id} created with initial agent: ${assignedAgent.username}`);
				console.log(`[Customer Request] Session agentIds: ${session.agentIds}, agentUsernames: ${session.agentUsernames}`);

				// NEW: Save customer's initial message to DB
				const initialMessage = new Message({
					chatSession: session._id,
					senderId: customerId,
					senderRole: 'customer',
					content: topic, // Use the topic as the initial message content
				});
				await initialMessage.save();
				console.log(`[Customer Request] Initial message saved for session ${session._id}: "${topic}"`);


				await updateAgentStatusBasedOnChats(io, assignedAgent._id);

				// FIXED: Customer's socket joins the room immediately upon session creation
				socket.join(session._id.toString());
				console.log(`[Customer Request] Customer socket ${socket.id} joined room ${session._id.toString()}.`);

				socket.emit('chat:assigned', {
					sessionId: session._id,
					agentNames: session.agentUsernames,
					customerId: customerId
				});
				console.log(`[Customer Request] Emitted chat:assigned to customer ${customerId} with agentNames: ${session.agentUsernames}`);


				if (agentSockets.has(assignedAgent._id.toString())) {
					agentSockets.get(assignedAgent._id.toString()).forEach(agentSocketId => {
						io.to(agentSocketId).emit('agent:chat_assigned_to_me', {
							sessionId: session._id,
							customerName: customerName,
							topic: topic
						});
						io.sockets.sockets.get(agentSocketId)?.join(session._id.toString());
						console.log(`[Customer Request] Emitted agent:chat_assigned_to_me to agent socket ${agentSocketId}`);
					});
				}
				console.log(`Chat session ${session._id} assigned to agent ${assignedAgent.username}`);

				io.to('agents').emit('agent:session_status_changed', {
					sessionId: session._id,
					newStatus: 'assigned',
					agentIds: session.agentIds,
					agentUsernames: session.agentUsernames
				});
				console.log(`[Customer Request] Broadcast agent:session_status_changed to all agents for session ${session._id}`);

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
					sessionId: session._id,
					customerId,
					customerName,
					customerEmail,
					topic
				});
				console.log(`[Customer Request] No agent available. Session ${session._id} added to queue.`);

				// NEW: Save customer's initial message to DB even if queued
				const initialMessage = new Message({
					chatSession: session._id,
					senderId: customerId,
					senderRole: 'customer',
					content: topic,
				});
				await initialMessage.save();
				console.log(`[Customer Request] Initial message saved for queued session ${session._id}: "${topic}"`);

				// FIXED: Customer's socket joins the room immediately upon session creation, even if queued
				socket.join(session._id.toString());
				console.log(`[Customer Request] Customer socket ${socket.id} joined room ${session._id.toString()} (queued).`);


				socket.emit('chat:queued', {
					position: customerQueue.length,
					sessionId: session._id,
					customerId: customerId
				});
				console.log(`[Customer Request] Emitted chat:queued to customer ${customerId}`);

				io.to('agents').emit('agent:new_queue_item', {sessionId: session._id, customerName});
				console.log(`[Customer Request] Broadcast agent:new_queue_item to all agents for session ${session._id}`);
			}
		});

		socket.on('customer:message', async ({sessionId, content}) => {
			console.log(`[Customer Message] Received message for session ${sessionId} from customer ${socket.customerId}: ${content}`);
			if (!socket.customerId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				// FIXED: Allow messages if status is 'pending', 'in_queue' or 'assigned'
				if (!chatSession || chatSession.customerId !== socket.customerId || !(chatSession.status === 'assigned' || chatSession.status === 'in_queue' || chatSession.status === 'pending')) {
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
					senderUsername: chatSession.customerName // NEW: Include sender's username
				});
				console.log(`[Customer Message] Emitted chat:message to room ${sessionId}`);

			} catch (error) {
				console.error('[Customer Message] Error saving customer message:', error);
			}
		});

		socket.on('customer:close_chat_request', async ({sessionId}) => {
			console.log(`[Customer Close] Customer ${socket.customerId} requesting to close session ${sessionId}`);
			if (!socket.customerId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status === 'closed') {
					console.warn(`[Customer Close] Customer ${socket.customerId} tried to close invalid/already closed session ${sessionId}`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();
				console.log(`[Customer Close] Session ${sessionId} status updated to closed.`);


				socket.leave(sessionId);
				io.to(sessionId).emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_closed'});
				socket.emit('chat:session_closed', {sessionId: sessionId, reason: 'customer_closed'});
				console.log(`[Customer Close] Emitted chat:session_closed to room ${sessionId} and customer.`);

				io.to('agents').emit('agent:session_closed_broadcast', {sessionId: sessionId});
				console.log(`[Customer Close] Broadcast agent:session_closed_broadcast for ${sessionId}`);


				for (const agentId of chatSession.agentIds) {
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
			if (!socket.customerId) return;
			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				if (!chatSession || chatSession.customerId !== socket.customerId || chatSession.status !== 'in_queue') {
					console.warn(`[Customer Cancel Queue] Customer ${socket.customerId} tried to cancel invalid/not-in-queue session ${sessionId}`);
					return;
				}

				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.sessionId.toString() !== sessionId);
				if (customerQueue.length < initialQueueLength) {
					io.to('agents').emit('agent:queue_updated', {});
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


		// --- Agent Side Events ---
		socket.on('agent:authenticate', async (agentId) => {
			console.log(`[Agent Auth] Agent ${agentId} attempting to authenticate.`);
			socket.agentId = agentId;
			socket.join('agents'); // All agents join a common 'agents' room

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
						{agentIds: agentId, status: 'assigned'}
					]
				}).sort({startedAt: 1});
				socket.emit('agent:initial_dashboard_data', {
					pendingAndAssignedChats,
					agentStatus: agent.status
				});
				console.log(`[Agent Auth] Emitted agent:initial_dashboard_data to agent ${agent.username}`);


				pendingAndAssignedChats.filter(s => s.status === 'assigned' && s.agentIds && s.agentIds.includes(agentId))
				.forEach(s => {
					socket.join(s._id.toString());
					console.log(`[Agent Auth] Agent ${agent.username} joined room ${s._id.toString()} for assigned chat.`);
				});

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
						// Defensive initialization after fetch
						session.agentIds = session.agentIds || [];
						session.agentUsernames = session.agentUsernames || [];

						if (session && session.status === 'in_queue') {
							session.agentIds.push(agent._id);
							session.agentUsernames.push(agent.username);
							session.status = 'assigned';
							await session.save();
							console.log(`[Agent Set Status] Assigned queued session ${session._id} to agent ${agent.username}`);
							console.log(`[Agent Set Status] Session agentIds: ${session.agentIds}, agentUsernames: ${session.agentUsernames}`);


							await updateAgentStatusBasedOnChats(io, agent._id);

							const customerSocketId = customerSockets.get(session.customerId);
							if (customerSocketId) {
								const customerSock = io.sockets.sockets.get(customerSocketId);
								if (customerSock) {
									customerSock.join(session._id.toString());
									customerSock.emit('chat:assigned', {
										sessionId: session._id,
										agentNames: session.agentUsernames,
										customerId: session.customerId
									});
									console.log(`[Agent Set Status] Emitted chat:assigned to customer ${session.customerId}`);
								}
							}

							socket.join(session._id.toString());
							socket.emit('agent:chat_assigned_to_me', {
								sessionId: session._id,
								customerName: session.customerName,
								topic: session.topic
							});
							console.log(`[Agent Set Status] Emitted agent:chat_assigned_to_me to agent ${agent.username}`);

							io.to('agents').emit('agent:queue_updated', {sessionId: session._id, status: 'assigned'});
							console.log(`[Agent Set Status] Broadcast agent:queue_updated`);

							io.to('agents').emit('agent:session_status_changed', {
								sessionId: session._id,
								newStatus: 'assigned',
								agentIds: session.agentIds,
								agentUsernames: session.agentUsernames
							});
							console.log(`[Agent Set Status] Broadcast agent:session_status_changed for session ${session._id}`);

						} else {
							console.warn(`[Agent Set Status] Queued session ${nextInQueue.sessionId} not found or no longer in queue. Skipping.`);
						}
					}
					io.to('agents').emit('agent:status_updated', {userId: agent._id, status: agent.status});
					console.log(`[Agent Set Status] Broadcast agent:status_updated for agent ${agent.username}`);
				}
			} catch (error) {
				console.error('[Agent Set Status] Error setting agent status:', error);
			}
		});

		socket.on('agent:message', async ({sessionId, content}) => {
			console.log(`[Agent Message] Received message for session ${sessionId} from agent ${socket.agentId}: ${content}`);
			if (!socket.agentId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				if (!chatSession || !chatSession.agentIds.includes(socket.agentId) || chatSession.status !== 'assigned') {
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


				io.to(sessionId).emit('chat:message', {
					sessionId,
					senderId: socket.agentId,
					senderRole: 'agent',
					content,
					timestamp: newMessage.timestamp,
					senderUsername: chatSession.agentUsernames[chatSession.agentIds.indexOf(socket.agentId)] // NEW: Include sender's username
				});
				console.log(`[Agent Message] Emitted chat:message to room ${sessionId}`);

			} catch (error) {
				console.error('[Agent Message] Error saving agent message:', error);
			}
		});

		socket.on('agent:join_chat', async ({sessionId}) => {
			console.log(`[Agent Join Chat] Agent ${socket.agentId} attempting to join session ${sessionId}`);
			if (!socket.agentId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession) {
					console.warn(`[Agent Join Chat] Agent ${socket.agentId} tried to join non-existent session ${sessionId}`);
					return;
				}

				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];
				console.log(`[Agent Join Chat] Session ${sessionId} current agentIds: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);


				if (chatSession.status === 'pending' || chatSession.status === 'in_queue') {
					const initialQueueLength = customerQueue.length;
					customerQueue = customerQueue.filter(item => item.sessionId.toString() !== sessionId);
					if (customerQueue.length < initialQueueLength) {
						console.log(`[Agent Join Chat] Removed session ${sessionId} from in-memory queue upon agent join.`);
					}

					const agent = await User.findById(socket.agentId);
					if (!agent) {
						console.error(`[Agent Join Chat] Agent ${socket.agentId} not found when joining chat.`);
						return;
					}

					chatSession.agentIds.push(agent._id);
					chatSession.agentUsernames.push(agent.username);
					chatSession.status = 'assigned';
					await chatSession.save();
					console.log(`[Agent Join Chat] Session ${sessionId} status updated to assigned by agent ${agent.username}.`);
					console.log(`[Agent Join Chat] Session agentIds after push: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);

					console.log("***********")
					await updateAgentStatusBasedOnChats(io, socket.agentId);
					console.log("^^^^^^^^^^^^^^^")
					const customerSocketId = customerSockets.get(chatSession.customerId);
					console.log("@@@@@@@@@@@@@")
					if (customerSocketId) {
						const customerSock = io.sockets.sockets.get(customerSocketId);
						if (customerSock) {
							customerSock.join(sessionId);
							customerSock.emit('chat:assigned', {
								sessionId: chatSession._id,
								agentNames: chatSession.agentUsernames,
								customerId: chatSession.customerId
							});
							console.log(`Customer ${chatSession.customerId} notified of assignment to agent ${agent.username}`);
						}
					}
					io.to('agents').emit('agent:queue_updated', {});
					io.to('agents').emit('agent:session_status_changed', {
						sessionId: chatSession._id,
						newStatus: 'assigned',
						agentIds: chatSession.agentIds,
						agentUsernames: chatSession.agentUsernames
					});
					console.log(`[Agent Join Chat] Broadcast agent:session_status_changed for session ${sessionId}`);

				} else if (chatSession.status === 'assigned') {
					if (!chatSession.agentIds.includes(socket.agentId)) {
						const agent = await User.findById(socket.agentId);
						if (!agent) {
							console.error(`[Agent Join Chat] Agent ${socket.agentId} not found when joining active chat.`);
							return;
						}

						chatSession.agentIds.push(agent._id);
						chatSession.agentUsernames.push(agent.username);
						await chatSession.save();
						console.log(`[Agent Join Chat] Agent ${agent.username} added to existing session ${sessionId}.`);
						console.log(`[Agent Join Chat] Session agentIds after push: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);

						await updateAgentStatusBasedOnChats(io, socket.agentId);

						io.to(sessionId).emit('chat:agent_joined', {
							sessionId: chatSession._id,
							agentId: agent._id,
							agentUsername: agent.username,
							allAgentNames: chatSession.agentUsernames
						});
						console.log(`[Agent Join Chat] Emitted chat:agent_joined to room ${sessionId}`);

						io.to('agents').emit('agent:session_status_changed', {
							sessionId: chatSession._id,
							newStatus: 'assigned',
							agentIds: chatSession.agentIds,
							agentUsernames: chatSession.agentUsernames
						});
						console.log(`[Agent Join Chat] Broadcast agent:session_status_changed for session ${chatSession._id}`);

					} else {
						console.log(`[Agent Join Chat] Agent ${socket.agentId} already in session ${sessionId}.`);
					}
				}

				socket.join(sessionId);
				console.log(`[Agent Join Chat] Agent socket ${socket.id} joined room ${sessionId}.`);

			} catch (error) {
				console.error('[Agent Join Chat] Error agent joining chat session:', error);
			}
		});

		socket.on('agent:invite_agent', async ({sessionId, invitedAgentId}) => {
			console.log(`[Agent Invite] Agent ${socket.agentId} inviting ${invitedAgentId} to session ${sessionId}`);
			if (!socket.agentId) return;
			if (!invitedAgentId) {
				console.warn(`[Agent Invite] Agent ${socket.agentId} tried to invite without invitedAgentId.`);
				return;
			}

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				if (!chatSession || chatSession.status !== 'assigned' || !chatSession.agentIds.includes(socket.agentId)) {
					console.warn(`[Agent Invite] Agent ${socket.agentId} tried to invite to invalid/unassigned/non-active session ${sessionId}.`);
					return;
				}

				if (chatSession.agentIds.includes(invitedAgentId)) {
					console.log(`[Agent Invite] Invited agent ${invitedAgentId} is already in session ${sessionId}. Skipping.`);
					return;
				}

				const invitedAgentUser = await User.findById(invitedAgentId);
				if (!invitedAgentUser || invitedAgentUser.role !== 'agent') {
					console.warn(`[Agent Invite] Invited ID ${invitedAgentId} is not a valid agent.`);
					return;
				}

				chatSession.agentIds.push(invitedAgentUser._id);
				chatSession.agentUsernames.push(invitedAgentUser.username);
				await chatSession.save();
				console.log(`[Agent Invite] Invited agent ${invitedAgentUser.username} added to session ${sessionId}.`);
				console.log(`[Agent Invite] Session agentIds after push: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);


				await updateAgentStatusBasedOnChats(io, invitedAgentUser._id);

				if (agentSockets.has(invitedAgentId)) {
					agentSockets.get(invitedAgentId).forEach(agentSocketId => {
						io.sockets.sockets.get(agentSocketId)?.join(sessionId);
						console.log(`[Agent Invite] Invited agent socket ${agentSocketId} joined room ${sessionId}.`);
						// NEW: Explicitly notify the invited agent's specific sockets
						io.to(agentSocketId).emit('agent:you_were_invited', {
							sessionId: chatSession._id,
							customerName: chatSession.customerName,
							topic: chatSession.topic,
							invitingAgentUsername: (async () => { // Wrapped in an async IIFE
								const invitingAgent = await User.findById(socket.agentId);
								return invitingAgent?.username || 'Another Agent';
							})()
						});
						console.log(`[Agent Invite] Emitted agent:you_were_invited to invited agent socket ${agentSocketId}`);
					});
				}

				io.to(sessionId).emit('chat:agent_joined', {
					sessionId: chatSession._id,
					agentId: invitedAgentUser._id,
					agentUsername: invitedAgentUser.username,
					allAgentNames: chatSession.agentUsernames
				});
				console.log(`[Agent Invite] Emitted chat:agent_joined to room ${sessionId}`);

				io.to('agents').emit('agent:session_status_changed', {
					sessionId: chatSession._id,
					newStatus: 'assigned',
					agentIds: chatSession.agentIds,
					agentUsernames: chatSession.agentUsernames
				});
				console.log(`[Agent Invite] Broadcast agent:session_status_changed for session ${chatSession._id}`);

				console.log(`Agent ${invitedAgentUser.username} invited to session ${sessionId} by ${socket.agentId}.`);

			} catch (error) {
				console.error('[Agent Invite] Error inviting agent to chat session:', error);
			}
		});

		socket.on('agent:leave_chat', async ({sessionId}) => {
			console.log(`[Agent Leave Chat] Agent ${socket.agentId} attempting to leave session ${sessionId}`);
			if (!socket.agentId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				if (!chatSession || chatSession.status === 'closed') {
					console.warn(`[Agent Leave Chat] Agent ${socket.agentId} tried to leave invalid/closed session ${sessionId}`);
					return;
				}

				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];
				console.log(`[Agent Leave Chat] Session ${sessionId} current agentIds: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);


				const agentIndex = chatSession.agentIds.indexOf(socket.agentId);
				let leavingAgentUsername = 'Unknown Agent';
				if (agentIndex > -1) {
					leavingAgentUsername = chatSession.agentUsernames[agentIndex];
					chatSession.agentIds.splice(agentIndex, 1);
					chatSession.agentUsernames.splice(agentIndex, 1);
				} else {
					console.warn(`[Agent Leave Chat] Agent ${socket.agentId} not found in session ${sessionId} to leave.`);
					return;
				}
				console.log(`[Agent Leave Chat] Session agentIds after splice: ${chatSession.agentIds}, agentUsernames: ${chatSession.agentUsernames}`);


				if (chatSession.agentIds.length === 0) {
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
					console.log(`Chat session ${sessionId} closed due to last agent (${socket.agentId}) disconnect.`);

				} else {
					await chatSession.save();
					console.log(`[Agent Leave Chat] Session ${sessionId} updated after agent left.`);
					io.to(sessionId).emit('chat:agent_left', {
						sessionId: chatSession._id,
						agentId: socket.agentId,
						agentUsername: leavingAgentUsername,
						allAgentNames: chatSession.agentUsernames
					});
					console.log(`[Agent Leave Chat] Emitted chat:agent_left to room ${sessionId}`);

					io.to('agents').emit('agent:session_status_changed', {
						sessionId: chatSession._id,
						newStatus: 'assigned',
						agentIds: chatSession.agentIds,
						agentUsernames: chatSession.agentUsernames
					});
					console.log(`[Agent Leave Chat] Broadcast agent:session_status_changed for session ${chatSession._id}`);

				}

				socket.leave(sessionId);
				console.log(`[Agent Leave Chat] Agent socket ${socket.id} left room ${sessionId}.`);
				await updateAgentStatusBasedOnChats(io, socket.agentId);

			} catch (error) {
				console.error('[Agent Leave Chat] Error agent leaving chat session:', error);
			}
		});


		socket.on('agent:close_chat', async (sessionId) => {
			console.log(`[Agent Close Chat] Agent ${socket.agentId} attempting to close session ${sessionId}`);
			if (!socket.agentId) return;

			try {
				const chatSession = await ChatSession.findById(sessionId);
				// Defensive initialization after fetch
				chatSession.agentIds = chatSession.agentIds || [];
				chatSession.agentUsernames = chatSession.agentUsernames || [];

				if (!chatSession || !chatSession.agentIds.includes(socket.agentId) || chatSession.status === 'closed') {
					console.warn(`[Agent Close Chat] Agent ${socket.agentId} tried to close invalid/already closed session ${sessionId} or not assigned.`);
					return;
				}

				chatSession.status = 'closed';
				chatSession.endedAt = Date.now();
				await chatSession.save();
				console.log(`[Agent Close Chat] Session ${sessionId} status updated to closed.`);


				const socketsInRoom = await io.in(sessionId).fetchSockets();
				socketsInRoom.forEach(s => {
					s.leave(sessionId);
					s.emit('chat:session_closed', {sessionId: sessionId, reason: 'agent_closed'});
				});
				console.log(`[Agent Close Chat] Emitted chat:session_closed to room ${sessionId}`);


				for (const agentId of chatSession.agentIds) {
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
				const initialQueueLength = customerQueue.length;
				customerQueue = customerQueue.filter(item => item.sessionId.toString() !== socket.id); // FIXED: Filter by sessionId
				if (customerQueue.length < initialQueueLength) {
					io.to('agents').emit('agent:queue_updated', {});
					console.log(`[Disconnect] Broadcast agent:queue_updated`);
				}

				const activeSession = await ChatSession.findOne({customerId: socket.customerId, status: 'assigned'});
				// FIXED: Check if activeSession is not null before accessing its properties
				if (activeSession) {
					// Defensive initialization after fetch
					activeSession.agentIds = activeSession.agentIds || [];
					activeSession.agentUsernames = activeSession.agentUsernames || [];

					activeSession.status = 'closed';
					activeSession.endedAt = Date.now();
					await activeSession.save();
					console.log(`[Disconnect] Session ${activeSession._id} closed due to customer disconnect.`);

					io.to(activeSession._id.toString()).emit('chat:session_closed', {
						sessionId: activeSession._id,
						reason: 'customer_disconnected'
					});
					io.to('agents').emit('agent:session_closed_broadcast', {sessionId: activeSession._id});
					console.log(`[Disconnect] Emitted chat:session_closed and agent:session_closed_broadcast for ${activeSession._id}`);


					for (const agentId of activeSession.agentIds) {
						await updateAgentStatusBasedOnChats(io, agentId);
					}
				}
				customerSockets.delete(socket.customerId);
			}

			if (socket.agentId) {
				console.log(`[Disconnect] Agent ${socket.agentId} disconnected.`);
				if (agentSockets.has(socket.agentId)) {
					agentSockets.get(socket.agentId).delete(socket.id);

					if (agentSockets.get(socket.agentId).size === 0) {
						agentSockets.delete(socket.agentId);
						await User.findByIdAndUpdate(socket.agentId, {isOnline: false, status: 'unavailable'});
						io.to('agents').emit('agent:online_status', {
							userId: socket.agentId,
							isOnline: false,
							status: 'unavailable'
						});
						console.log(`[Disconnect] Agent ${socket.agentId} is now truly offline.`);

						const assignedChats = await ChatSession.find({agentIds: socket.agentId, status: 'assigned'});
						// FIXED: Check if session is not null before accessing its properties
						for (const assignedChat of assignedChats) { // Renamed loop variable to assignedChat
							// Defensive initialization after fetch
							assignedChat.agentIds = assignedChat.agentIds || [];
							assignedChat.agentUsernames = assignedChat.agentUsernames || [];

							const agentIndex = assignedChat.agentIds.indexOf(socket.agentId);
							if (agentIndex > -1) {
								assignedChat.agentIds.splice(agentIndex, 1);
								assignedChat.agentUsernames.splice(agentIndex, 1);
							}

							if (assignedChat.agentIds.length === 0) {
								assignedChat.status = 'closed';
								assignedChat.endedAt = Date.now();
								await assignedChat.save();
								io.to(assignedChat._id.toString()).emit('chat:session_closed', {
									sessionId: assignedChat._id,
									reason: 'agent_disconnected_last'
								});
								io.to('agents').emit('agent:session_closed_broadcast', {sessionId: assignedChat._id});
								customerSockets.delete(assignedChat.customerId);
								console.log(`[Disconnect] Session ${assignedChat._id} closed due to last agent (${socket.agentId}) disconnect.`);
							} else {
								await assignedChat.save();
								io.to(assignedChat._id.toString()).emit('chat:agent_left', {
									sessionId: assignedChat._id,
									agentId: socket.agentId,
									agentUsername: 'Disconnected Agent',
									allAgentNames: assignedChat.agentUsernames
								});
								io.to('agents').emit('agent:session_status_changed', {
									sessionId: assignedChat._id,
									newStatus: 'assigned',
									agentIds: assignedChat.agentIds,
									agentUsernames: assignedChat.agentUsernames
								});
								console.log(`Agent ${socket.agentId} disconnected from session ${assignedChat._id}. Other agents remaining.`);
							}
						}
					}
				}
			}
		});
	});
};
