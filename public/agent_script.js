// public/agent_script.js
const socket = io();

// --- Elements for agent_login.html ---
const agentLoginForm = document.getElementById('agentLoginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginMessageDiv = document.getElementById('message');

const agentRegisterForm = document.getElementById('agentRegisterForm');
const regUsernameInput = document.getElementById('regUsername');
const regPasswordInput = document.getElementById('regPassword');
const regRoleSelect = document.getElementById('regRole');
const regMessageDiv = document.getElementById('regMessage');

// --- Elements for agent_dashboard.html ---
const agentUsernameSpan = document.getElementById('agentUsername');
const agentIdSpan = document.getElementById('agentId');
const myAgentStatusSpan = document.getElementById('myAgentStatus');
const setAvailableBtn = document.getElementById('setAvailableBtn');
const setUnavailableBtn = document.getElementById('setUnavailableBtn');
const chatSessionsList = document.getElementById('chatSessionsList');
const agentChatArea = document.getElementById('agentChatArea');
const currentChatCustomerNameSpan = document.getElementById('currentChatCustomerName');
const agentChatMessagesDiv = document.getElementById('agentChatMessages');
const agentMessageInput = document.getElementById('agentMessageInput');
const sendAgentMessageButton = document.getElementById('sendAgentMessageButton');
const closeChatButton = document.getElementById('closeChatButton');
const noChatSelectedDiv = document.getElementById('noChatSelected');
const welcomeHeader = document.getElementById('welcomeHeader');

// NEW: Multi-agent specific elements
const inviteAgentBtn = document.getElementById('inviteAgentBtn');
const otherAgentsDropdown = document.getElementById('otherAgentsDropdown');
const leaveChatButton = document.getElementById('leaveChatButton');


let agentToken = localStorage.getItem('agentToken');
let agentId = localStorage.getItem('agentId');
let agentUsername = localStorage.getItem('agentUsername');
let currentAgentStatus = null; // To track agent's availability status
let activeSessionId = null; // The sessionId currently open in the chat window

// Map to store session details by sessionId for quick lookup
// MODIFIED: Added agentUsernames to sessionDataMap
const sessionDataMap = new Map(); // sessionId -> { customerName, topic, messages: [], status: string, hasNewMessage: boolean, agentIds: [], agentUsernames: [] }

// --- Login/Register Logic ---
if (agentLoginForm) {
	agentLoginForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const username = usernameInput.value.trim();
		const password = passwordInput.value.trim();

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
			const data = await response.json();

			if (response.ok) {
				localStorage.setItem('agentToken', data.token);
				localStorage.setItem('agentId', data.userId);
				localStorage.setItem('agentUsername', data.username);
				window.location.href = '/agent_dashboard.html';
			} else {
				loginMessageDiv.textContent = data.msg || 'Login failed.';
				loginMessageDiv.style.color = 'red';
			}
		} catch (error) {
			console.error('Login error:', error);
			loginMessageDiv.textContent = 'An error occurred during login.';
			loginMessageDiv.style.color = 'red';
		}
	});
}

if (agentRegisterForm) {
	agentRegisterForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const username = regUsernameInput.value.trim();
		const password = regPasswordInput.value.trim();
		const role = regRoleSelect.value;

		try {
			const response = await fetch('/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password, role })
			});
			const data = await response.json();

			regMessageDiv.textContent = data.msg;
			regMessageDiv.style.color = response.ok ? 'green' : 'red';
			if (response.ok) {
				regUsernameInput.value = '';
				regPasswordInput.value = '';
			}
		} catch (error) {
			console.error('Register error:', error);
			regMessageDiv.textContent = 'An error occurred during registration.';
			regMessageDiv.style.color = 'red';
		}
	});
}

// --- Dashboard Logic Functions (Moved to global scope for accessibility) ---

async function setAgentStatus(status) {
	// FIXED: Emit socket event instead of API call for status update
	if (!socket.connected) {
		alert('Socket not connected. Please refresh the page.');
		return;
	}
	socket.emit('agent:set_status', { status });
	console.log(`[Agent Script] Emitted agent:set_status with status: ${status}`);
}

async function loadChatSessions() {
	try {
		console.log('[Agent Script] Fetching chat sessions...');
		const response = await fetch('/api/chat_sessions', {
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				alert('Session expired. Please log in again.');
				logoutAgent();
				return;
			}
			throw new Error('Failed to fetch chat sessions');
		}
		const sessions = await response.json();
		console.log('[Agent Script] API returned sessions:', sessions);

		chatSessionsList.innerHTML = '';
		console.log('[Agent Script] Chat list cleared.');

		sessions.forEach(session => {
			console.log('[Agent Script] Rendering session:', session._id, session.customerName, session.status);
			const existingSessionInfo = sessionDataMap.get(session._id);
			// MODIFIED: Store agentIds and agentUsernames
			sessionDataMap.set(session._id, {
				customerName: session.customerName,
				topic: session.topic,
				messages: existingSessionInfo ? existingSessionInfo.messages : [],
				status: session.status,
				hasNewMessage: (session.status === 'pending' || session.status === 'in_queue' || (existingSessionInfo && existingSessionInfo.hasNewMessage)), // Keep new message if already set
				agentIds: session.agentIds || [], // Ensure it's an array
				agentUsernames: session.agentUsernames || [] // Ensure it's an array
			});
			renderChatSessionListItem(session);
		});
		console.log('[Agent Script] Finished rendering sessions.');
		return sessions;
	} catch (error) {
		console.error('[Agent Script] Error loading chat sessions:', error);
		alert('Failed to load chat sessions.');
		return [];
	}
}

function renderChatSessionListItem(session) {
	const li = document.createElement('li');
	li.setAttribute('data-session-id', session._id);
	if (session._id === activeSessionId) {
		li.classList.add('active-chat');
	}
	if (sessionDataMap.has(session._id) && sessionDataMap.get(session._id).hasNewMessage) {
		li.classList.add('has-new-message');
	}

	li.innerHTML = `
        <strong>${session.customerName}</strong>
        <span>${session.topic}</span>
        <span style="font-size: 0.8em; color: #aab; margin-top: 5px;">Status: ${session.status.replace('_', ' ')}</span>
        <!-- NEW: Display agents in chat list item -->
        <span style="font-size: 0.75em; color: #999; margin-top: 3px;">Agents: ${session.agentUsernames && session.agentUsernames.length > 0 ? session.agentUsernames.join(', ') : 'None'}</span>
    `;
	li.addEventListener('click', () => {
		if (session.status === 'pending' || session.status === 'in_queue') {
			// FIXED: This is for agent self-joining (accepting a new chat)
			socket.emit('agent:join_chat', { sessionId: session._id });
			console.log(`[Agent Script] Agent attempting to join chat: ${session._id}`);

			openChatSession(session._id);
			const currentSelected = document.querySelector('.chat-list li.active-chat');
			if (currentSelected) {
				currentSelected.classList.remove('active-chat');
			}
			li.classList.add('active-chat');
			li.classList.remove('has-new-message');
		} else if (session.status === 'assigned' && session.agentIds.includes(agentId)) {
			// If already assigned to this agent, just open it
			openChatSession(session._id);
		} else if (session.status === 'assigned' && !session.agentIds.includes(agentId)) {
			alert('This chat is assigned to another agent(s). You can invite yourself or ask them to invite you.');
		}
	});
	chatSessionsList.appendChild(li);
}

async function openChatSession(sessionId) {
	const previouslyActive = document.querySelector('.chat-list li.active-chat');
	if (previouslyActive) {
		previouslyActive.classList.remove('active-chat');
	}

	const currentActive = document.querySelector(`li[data-session-id="${sessionId}"]`);
	if (currentActive) {
		currentActive.classList.add('active-chat');
		currentActive.classList.remove('has-new-message');
		if (sessionDataMap.has(sessionId)) {
			sessionDataMap.get(sessionId).hasNewMessage = false;
		}
	}

	activeSessionId = sessionId;
	const sessionInfo = sessionDataMap.get(sessionId);
	if (sessionInfo) {
		welcomeHeader.style.display = 'none';
		noChatSelectedDiv.style.display = 'none';
		agentChatArea.style.display = 'flex';
		currentChatCustomerNameSpan.textContent = sessionInfo.customerName;

		await populateOtherAgentsDropdown(sessionId);

		// FIXED: Ensure messages are fetched when opening a chat
		await fetchAndDisplayMessages(sessionId);
	}
}

async function fetchAndDisplayMessages(sessionId) {
	agentChatMessagesDiv.innerHTML = '';
	try {
		console.log(`[Agent Script] Fetching messages for session ${sessionId}...`); // Debug log
		const response = await fetch(`/api/chat_sessions/${sessionId}/messages`, {
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			const errorText = await response.text(); // Get more detail from error response
			console.error(`[Agent Script] Failed to fetch messages: HTTP status ${response.status}, Response: ${errorText}`); // Debug log
			throw new Error(`Failed to fetch messages for session: ${response.status} ${response.statusText} - ${errorText}`);
		}
		const messages = await response.json();
		console.log(`[Agent Script] Received ${messages.length} messages for session ${sessionId}.`); // Debug log
		sessionDataMap.get(sessionId).messages = messages;
		messages.forEach(msg => {
			appendAgentMessage(msg.senderId, msg.content, msg.senderRole, msg.senderUsername); // MODIFIED: Pass senderUsername
		});
		agentChatMessagesDiv.scrollTop = agentChatMessagesDiv.scrollHeight;
	}
		// FIXED: Catch specific error for 403 Forbidden and provide more user-friendly message
	catch (error) {
		console.error('[Agent Script] Error fetching messages:', error);
		if (error.message.includes('403')) {
			appendAgentMessage('System', 'Error: You are not assigned to this chat session or it is no longer active.', 'system');
		} else {
			appendAgentMessage('System', 'Failed to load messages. Please try again.', 'system');
		}
	}
}

function appendAgentMessage(senderId, content, role, senderUsername = 'Agent') { // MODIFIED: Added senderUsername parameter
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble');

	let senderDisplayName = '';
	if (role === 'agent') {
		// FIXED: Differentiate between current agent and other agents
		if (senderId === agentId) { // If message is from current agent
			messageBubble.classList.add('sent');
			senderDisplayName = 'You';
		} else { // If message is from another agent in the chat
			messageBubble.classList.add('received');
			senderDisplayName = senderUsername; // Use the provided senderUsername
		}
	} else if (role === 'customer') {
		messageBubble.classList.add('received');
		const session = sessionDataMap.get(activeSessionId);
		senderDisplayName = session ? session.customerName : senderId;
	} else {
		messageBubble.classList.add('received');
		senderDisplayName = 'System';
	}
	messageBubble.innerHTML = `<strong>${senderDisplayName}:</strong> ${content}`;

	agentChatMessagesDiv.appendChild(messageBubble);
	agentChatMessagesDiv.scrollTop = agentChatMessagesDiv.scrollHeight;
}

async function sendAgentMessage() {
	const message = agentMessageInput.value.trim();
	if (message && activeSessionId) {
		console.log(`[Agent Script] Sending message: "${message}" to session ${activeSessionId}`); // Debug log
		socket.emit('agent:message', { sessionId: activeSessionId, content: message });
		// FIXED: Pass agentUsername to appendAgentMessage for local display
		appendAgentMessage(agentId, message, 'agent', agentUsername); // Pass agentUsername for local display
		agentMessageInput.value = '';
	}
}

function logoutAgent() {
	localStorage.removeItem('agentToken');
	localStorage.removeItem('agentId');
	localStorage.removeItem('agentUsername');
	socket.disconnect();
	window.location.href = '/agent_login.html';
}

function updateStatusButtonHighlight() {
	setAvailableBtn.classList.remove('active-status');
	setUnavailableBtn.classList.remove('active-status');

	if (currentAgentStatus === 'available') {
		setAvailableBtn.classList.add('active-status');
	} else if (currentAgentStatus === 'unavailable') {
		setUnavailableBtn.classList.add('active-status');
	}
}

// NEW: Populate other agents dropdown
async function populateOtherAgentsDropdown(currentChatSessionId) {
	otherAgentsDropdown.innerHTML = '';
	try {
		console.log('[Agent Script] Populating invite agent dropdown...'); // Debug log
		const response = await fetch('/api/agents', {
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[Agent Script] Failed to fetch agents for dropdown: HTTP status ${response.status}, Response: ${errorText}`); // Debug log
			throw new Error('Failed to fetch agents for dropdown');
		}
		const allAgents = await response.json();
		const currentSessionInfo = sessionDataMap.get(currentChatSessionId);
		const agentsInThisChat = currentSessionInfo ? currentSessionInfo.agentIds : [];
		console.log(`[Agent Script] All agents:`, allAgents); // Debug log
		console.log(`[Agent Script] Agents in current chat:`, agentsInThisChat); // Debug log


		allAgents.forEach(agent => {
			if (agent._id !== agentId && !agentsInThisChat.includes(agent._id)) {
				const a = document.createElement('a');
				a.href = '#';
				a.textContent = agent.username;
				a.setAttribute('data-agent-id', agent._id);
				a.addEventListener('click', (e) => {
					e.preventDefault();
					// FIXED: Emit agent:invite_agent instead of agent:join_chat
					socket.emit('agent:invite_agent', { sessionId: activeSessionId, invitedAgentId: agent._id });
					console.log(`[Agent Script] Emitted agent:invite_agent for session ${activeSessionId}, invited: ${agent.username}`); // Debug log
					inviteAgentBtn.parentElement.classList.remove('show');
				});
				otherAgentsDropdown.appendChild(a);
			}
		});

		if (otherAgentsDropdown.children.length === 0) {
			const span = document.createElement('span');
			span.style.padding = '12px 16px';
			span.style.display = 'block';
			span.style.color = '#777';
			span.textContent = 'No other agents available to invite.';
			otherAgentsDropdown.appendChild(span);
		}
		console.log(`[Agent Script] Dropdown populated with ${otherAgentsDropdown.children.length} agents.`); // Debug log


	} catch (error) {
		console.error('[Agent Script] Error populating agents dropdown:', error);
	}
}

// NEW: Toggle dropdown visibility
if (inviteAgentBtn) {
	inviteAgentBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		inviteAgentBtn.parentElement.classList.toggle('show');
		if (activeSessionId) {
			populateOtherAgentsDropdown(activeSessionId);
		}
	});

	window.addEventListener('click', (e) => {
		if (inviteAgentBtn && !inviteAgentBtn.contains(e.target) && !otherAgentsDropdown.contains(e.target)) {
			inviteAgentBtn.parentElement.classList.remove('show');
		}
	});
}

// --- Event Listeners and Initial Logic ---
if (agentUsernameSpan) {
	setAvailableBtn.addEventListener('click', () => setAgentStatus('available'));
	setUnavailableBtn.addEventListener('click', () => setAgentStatus('unavailable'));
	sendAgentMessageButton.addEventListener('click', sendAgentMessage);
	agentMessageInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			sendAgentMessage();
		}
	});
	closeChatButton.addEventListener('click', () => {
		if (activeSessionId) {
			socket.emit('agent:close_chat', activeSessionId);
		}
	});
	if (leaveChatButton) {
		leaveChatButton.addEventListener('click', () => {
			if (activeSessionId) {
				socket.emit('agent:leave_chat', { sessionId: activeSessionId });
				activeSessionId = null;
				agentChatArea.style.display = 'none';
				welcomeHeader.style.display = 'none';
				noChatSelectedDiv.style.display = 'block';
			}
		});
	}

	if (!agentToken || !agentId || !agentUsername) {
		window.location.href = '/agent_login.html';
	} else {
		agentUsernameSpan.textContent = agentUsername;
		agentIdSpan.textContent = agentId;
		socket.emit('agent:authenticate', agentId);
		loadChatSessions();
	}
}


// --- Socket.IO Listeners (for agent_dashboard.html) ---

socket.on('agent:initial_dashboard_data', ({ pendingAndAssignedChats, agentStatus }) => {
	console.log('[Agent Socket] agent:initial_dashboard_data received.'); // Debug log
	myAgentStatusSpan.textContent = agentStatus.charAt(0).toUpperCase() + agentStatus.slice(1);
	currentAgentStatus = agentStatus;
	updateStatusButtonHighlight();

	chatSessionsList.innerHTML = '';
	pendingAndAssignedChats.forEach(session => {
		const hasNew = (session.status === 'pending' || session.status === 'in_queue');
		const existingSessionInfo = sessionDataMap.get(session._id);
		sessionDataMap.set(session._id, {
			customerName: session.customerName,
			topic: session.topic,
			messages: existingSessionInfo ? existingSessionInfo.messages : [],
			status: session.status,
			hasNewMessage: hasNew,
			agentIds: session.agentIds || [],
			agentUsernames: session.agentUsernames || []
		});
		renderChatSessionListItem(session);
	});
});

socket.on('agent:status_updated', ({ userId, status }) => {
	console.log(`[Agent Socket] agent:status_updated received for ${userId}: ${status}`); // Debug log
	if (userId === agentId) {
		myAgentStatusSpan.textContent = status.charAt(0).toUpperCase() + status.slice(1);
		currentAgentStatus = status;
		updateStatusButtonHighlight();
	}
});

socket.on('agent:new_queue_item', ({ sessionId, customerName }) => {
	console.log(`[Agent Socket] agent:new_queue_item received for session ${sessionId}, customer ${customerName}.`); // Debug log
	sessionDataMap.set(sessionId, {
		customerName: customerName,
		topic: 'New Customer Request',
		messages: [],
		status: 'in_queue',
		hasNewMessage: true,
		agentIds: [],
		agentUsernames: []
	});
	loadChatSessions();
});

socket.on('agent:chat_assigned_to_me', async ({ sessionId, customerName, topic }) => {
	console.log(`[Agent Socket] agent:chat_assigned_to_me received for session ${sessionId}.`); // Debug log
	let sessionInfo = sessionDataMap.get(sessionId);
	if (sessionInfo) {
		sessionInfo.status = 'assigned';
		sessionInfo.hasNewMessage = true;
	} else {
		sessionDataMap.set(sessionId, {
			customerName, topic, messages: [], status: 'assigned', hasNewMessage: true, agentIds: [], agentUsernames: []
		});
	}

	await loadChatSessions();

	if (!activeSessionId) {
		let attempts = 0;
		const maxAttempts = 20;
		const checkInterval = 100;

		const checkAndOpenChat = () => {
			const liElement = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
			if (liElement) {
				console.log(`[Agent Socket] Found LI element for session ${sessionId}. Opening chat automatically.`);
				openChatSession(sessionId);
			} else if (attempts < maxAttempts) {
				attempts++;
				console.log(`[Agent Socket] Attempt ${attempts}/${maxAttempts}: LI element not found for ${sessionId} during auto-open. Retrying...`);
				setTimeout(checkAndOpenChat, checkInterval);
			} else {
				console.warn(`[Agent Socket] Could not confirm chat session LI for ${sessionId} in DOM for auto-open. Manual selection may be needed.`);
			}
		};
		setTimeout(checkAndOpenChat, checkInterval);
	} else {
		const li = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
		if (li) {
			li.classList.add('has-new-message');
		}
	}
});

socket.on('agent:session_status_changed', ({ sessionId, newStatus, agentIds, agentUsernames }) => {
	console.log(`[Agent Socket] agent:session_status_changed received for session ${sessionId}. New Status: ${newStatus}, Agents: ${agentUsernames}.`); // Debug log
	if (sessionDataMap.has(sessionId)) {
		const sessionInfo = sessionDataMap.get(sessionId);
		sessionInfo.status = newStatus;
		sessionInfo.agentIds = agentIds;
		sessionInfo.agentUsernames = agentUsernames;
	}
	loadChatSessions();
	if (activeSessionId === sessionId) {
		populateOtherAgentsDropdown(sessionId);
	}
});


socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp, senderUsername }) => { // MODIFIED: Added senderUsername
	console.log(`[Agent Socket] chat:message received for session ${sessionId}. Sender: ${senderUsername} (${senderId}), Role: ${senderRole}, Content: "${content}"`); // Debug log
	if (sessionId === activeSessionId) {
		if (senderRole === 'agent' && senderId === agentId) {
			console.log('[Agent Socket] Ignoring self-sent message.'); // Debug log
			return;
		}
		appendAgentMessage(senderId, content, senderRole, senderUsername); // MODIFIED: Pass senderUsername
	} else {
		console.log(`[Agent Socket] Message for inactive session ${sessionId}. Marking new.`); // Debug log
		if (sessionDataMap.has(sessionId)) {
			sessionDataMap.get(sessionId).hasNewMessage = true;
		}
		const li = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
		if (li) {
			li.classList.add('has-new-message');
		}
	}
});

socket.on('chat:agent_joined', ({ sessionId, agentId: joinedAgentId, agentUsername: joinedAgentUsername, allAgentNames }) => {
	console.log(`[Agent Socket] chat:agent_joined received. Agent: ${joinedAgentUsername}, All Agents: ${allAgentNames}`); // Debug log
	if (sessionId === activeSessionId) {
		if (sessionDataMap.has(sessionId)) {
			sessionDataMap.get(sessionId).agentIds = sessionDataMap.get(sessionId).agentIds.includes(joinedAgentId) ? sessionDataMap.get(sessionId).agentIds : [...sessionDataMap.get(sessionId).agentIds, joinedAgentId];
			sessionDataMap.get(sessionId).agentUsernames = allAgentNames;
		}
		appendAgentMessage('System', `${joinedAgentUsername} has joined this chat.`, 'system');
		populateOtherAgentsDropdown(sessionId);
	}
});

socket.on('chat:agent_left', ({ sessionId, agentId: leftAgentId, agentUsername: leftAgentUsername, allAgentNames }) => {
	console.log(`[Agent Socket] chat:agent_left received. Agent: ${leftAgentUsername}, All Agents: ${allAgentNames}`); // Debug log
	if (sessionId === activeSessionId) {
		if (sessionDataMap.has(sessionId)) {
			sessionDataMap.get(sessionId).agentIds = sessionDataMap.get(sessionId).agentIds.filter(id => id !== leftAgentId);
			sessionDataMap.get(sessionId).agentUsernames = allAgentNames;
		}
		appendAgentMessage('System', `${leftAgentUsername} has left this chat.`, 'system');
		populateOtherAgentsDropdown(sessionId);
	}
});

// NEW: Listener for when this agent is invited to a chat
socket.on('agent:you_were_invited', ({ sessionId, customerName, topic, invitingAgentUsername }) => {
	console.log(`[Agent Socket] agent:you_were_invited received for session ${sessionId}. Inviting agent: ${invitingAgentUsername}`); // Debug log
	// Update sessionDataMap to mark this chat as new/assigned
	sessionDataMap.set(sessionId, {
		customerName: customerName,
		topic: topic,
		messages: [], // Clear messages, will fetch on open
		status: 'assigned', // It's now assigned to you (or you're joining)
		hasNewMessage: true, // Mark for red dot
		agentIds: [], // Will be updated by agent:session_status_changed
		agentUsernames: [] // Will be updated by agent:session_status_changed
	});
	loadChatSessions(); // Reload list to show highlight

	// Display an on-screen notification
	alert(`You've been invited to a chat with ${customerName} by ${invitingAgentUsername}! Topic: "${topic}"`);
});


socket.on('agent:session_closed_broadcast', ({ sessionId }) => {
	console.log(`[Agent Socket] Session ${sessionId} closed broadcast received. Reloading sessions.`);
	sessionDataMap.delete(sessionId);
	loadChatSessions();

	if (activeSessionId === sessionId) {
		activeSessionId = null;
		agentChatArea.style.display = 'none';
		welcomeHeader.style.display = 'none';
		noChatSelectedDiv.style.display = 'block';
	}
});

socket.on('chat:session_closed', ({ sessionId, reason }) => {
	console.log(`[Agent Socket] chat:session_closed received for session ${sessionId}. Reason: ${reason}`); // Debug log
	if (sessionId === activeSessionId) {
		appendAgentMessage('System', `Chat session closed. Reason: ${reason.replace('_', ' ')}.`, 'system');
	}
});

socket.on('agent:queue_updated', () => {
	console.log('[Agent Socket] Queue updated. Reloading sessions.'); // Debug log
	loadChatSessions();
});

socket.on('agent:online_status', ({ userId, isOnline, status }) => {
	console.log(`[Agent Socket] Agent online status received for ${userId}: isOnline=${isOnline}, status=${status}`); // Debug log
});
