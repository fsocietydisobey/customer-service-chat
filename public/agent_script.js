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
const myAgentStatus = document.getElementById('myAgentStatus');
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
const sessionDataMap = new Map(); // sessionId -> session details

// --- Login/Register Logic ---
if (agentLoginForm) {
	agentLoginForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const username = usernameInput.value.trim();
		const password = passwordInput.value.trim(); // Trim password for consistency, but don't log

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

		chatSessionsList.innerHTML = ''; // Clear existing list items
		console.log('[Agent Script] Chat list cleared.');

		sessions.forEach(session => {
			console.log('[Agent Script] Processing session:', session._id, session.customerName, session.status);
			const existingSessionInfo = sessionDataMap.get(session._id);

			// IMPORTANT: agentIds are ALREADY strings from the API response
			sessionDataMap.set(session._id, {
				customerName: session.customerName,
				topic: session.topic,
				messages: existingSessionInfo ? existingSessionInfo.messages : [], // Keep existing messages if available
				status: session.status,
				hasNewMessage: (session.status === 'pending' || session.status === 'in_queue' || (existingSessionInfo && existingSessionInfo.hasNewMessage)),
				agentIds: session.agentIds || [], // Now guaranteed to be strings from API
				agentUsernames: session.agentUsernames || [] // Now guaranteed to be populated from API
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

	const sessionInfo = sessionDataMap.get(session._id); // Get the potentially updated info from map

	li.innerHTML = `
        <strong>${sessionInfo.customerName}</strong>
        <span>${sessionInfo.topic}</span>
        <span style="font-size: 0.8em; color: #aab; margin-top: 5px;">Status: ${sessionInfo.status.replace('_', ' ')}</span>
        <span style="font-size: 0.75em; color: #999; margin-top: 3px;">Agents: ${sessionInfo.agentUsernames && sessionInfo.agentUsernames.length > 0 ? sessionInfo.agentUsernames.join(', ') : 'None'}</span>
    `;
	li.addEventListener('click', () => {
		const clickedSessionInfo = sessionDataMap.get(session._id); // Get latest info on click

		// agentIds are ALREADY strings in sessionDataMap, so direct comparison is fine
		if (clickedSessionInfo.status === 'pending' || clickedSessionInfo.status === 'in_queue') {
			// This is for agent self-joining (accepting a new chat)
			socket.emit('agent:join_chat', { sessionId: session._id });
			console.log(`[Agent Script] Agent attempting to join chat (from queue/pending): ${session._id}`);

			// Optimistically update UI
			openChatSession(session._id);
			const currentSelected = document.querySelector('.chat-list li.active-chat');
			if (currentSelected) {
				currentSelected.classList.remove('active-chat');
			}
			li.classList.add('active-chat');
			li.classList.remove('has-new-message');
		}
		// agentId (from localStorage) is a string, agentIds in map are now strings too.
		else if (clickedSessionInfo.status === 'assigned' && clickedSessionInfo.agentIds.includes(agentId)) {
			// If already assigned to this agent, just open it without asking to join
			console.log(`[Agent Script] Agent ${agentId} opening already assigned chat: ${session._id}`);
			openChatSession(session._id);
		}
		// If assigned to other agents, offer to join
		else if (clickedSessionInfo.status === 'assigned' && !clickedSessionInfo.agentIds.includes(agentId)) {
			if (confirm('This chat is assigned to other agent(s). Do you want to join this chat?')) {
				socket.emit('agent:join_chat', { sessionId: session._id });
				console.log(`[Agent Script] Agent attempting to join chat (already assigned to others): ${session._id}`);
				// Optimistically update UI, server will confirm and update again
				openChatSession(session._id);
				const currentSelected = document.querySelector('.chat-list li.active-chat');
				if (currentSelected) {
					currentSelected.classList.remove('active-chat');
				}
				li.classList.add('active-chat');
				li.classList.remove('has-new-message');
			}
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

		// Populate dropdown with agents not currently in this chat
		await populateOtherAgentsDropdown(sessionId);

		await fetchAndDisplayMessages(sessionId);
	} else {
		// If sessionInfo is somehow missing (e.g., chat was closed but client not updated yet)
		console.warn(`[Agent Script] Attempted to open session ${sessionId} but no data in map. Reloading sessions.`);
		// Try reloading sessions to get current state
		await loadChatSessions();
		const recheckedSessionInfo = sessionDataMap.get(sessionId);
		if (recheckedSessionInfo) {
			openChatSession(sessionId); // Retry opening
		} else {
			console.error(`[Agent Script] Session ${sessionId} still not found after reload. Cannot open.`);
			activeSessionId = null;
			agentChatArea.style.display = 'none';
			noChatSelectedDiv.style.display = 'block';
			welcomeHeader.style.display = 'block'; // Show welcome again
		}
	}
}

async function fetchAndDisplayMessages(sessionId) {
	agentChatMessagesDiv.innerHTML = ''; // Clear previous messages
	try {
		console.log(`[Agent Script] Fetching messages for session ${sessionId}...`);
		const response = await fetch(`/api/chat_sessions/${sessionId}/messages`, {
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[Agent Script] Failed to fetch messages: HTTP status ${response.status}, Response: ${errorText}`);
			throw new Error(`Failed to fetch messages for session: ${response.status} ${response.statusText} - ${errorText}`);
		}
		const messages = await response.json();
		console.log(`[Agent Script] Received ${messages.length} messages for session ${sessionId}.`);

		const sessionInfo = sessionDataMap.get(sessionId);
		// Fetch agent usernames once if needed for historical messages that might not have senderUsername
		let agentUsernameMap = new Map();
		if (sessionInfo && sessionInfo.agentIds && sessionInfo.agentIds.length > 0) {
			try {
				const agentResponse = await fetch('/api/agents/all', { // Assuming a route to get all agent usernames by ID
					headers: { 'Authorization': `Bearer ${agentToken}` }
				});
				if (agentResponse.ok) {
					const allAgents = await agentResponse.json();
					allAgents.forEach(agent => agentUsernameMap.set(agent._id, agent.username));
				}
			} catch (err) {
				console.warn('[Agent Script] Could not fetch all agent usernames for historical messages:', err);
			}
		}


		messages.forEach(msg => {
			let displaySenderUsername = msg.senderUsername; // Prefer username from payload
			if (msg.senderRole === 'agent' && !displaySenderUsername) {
				// Fallback for older messages or if username wasn't directly in payload
				displaySenderUsername = agentUsernameMap.get(msg.senderId) || 'Agent';
			} else if (msg.senderRole === 'customer' && !displaySenderUsername) {
				displaySenderUsername = sessionInfo ? sessionInfo.customerName : msg.senderId;
			}
			appendAgentMessage(msg.senderId, msg.content, msg.senderRole, displaySenderUsername);
		});
		agentChatMessagesDiv.scrollTop = agentChatMessagesDiv.scrollHeight;
	}
	catch (error) {
		console.error('[Agent Script] Error fetching messages:', error);
		if (error.message.includes('403')) {
			appendAgentMessage('System', 'Error: You are not assigned to this chat session or it is no longer active.', 'system');
		} else {
			appendAgentMessage('System', 'Failed to load messages. Please try again.', 'system');
		}
	}
}

function appendAgentMessage(senderId, content, role, senderUsername) {
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble');

	let senderDisplayName = '';
	if (role === 'agent') {
		if (senderId === agentId) { // If message is from current agent
			messageBubble.classList.add('sent');
			senderDisplayName = 'You';
		} else { // If message is from another agent in the chat
			messageBubble.classList.add('received');
			senderDisplayName = senderUsername || 'Another Agent'; // Use provided username or fallback
		}
	} else if (role === 'customer') {
		messageBubble.classList.add('received');
		const session = sessionDataMap.get(activeSessionId);
		senderDisplayName = senderUsername || (session ? session.customerName : senderId);
	} else { // System messages
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
		console.log(`[Agent Script] Sending message: "${message}" to session ${activeSessionId}`);
		socket.emit('agent:message', { sessionId: activeSessionId, content: message });
		appendAgentMessage(agentId, message, 'agent', agentUsername); // Pass agentUsername for local display
		agentMessageInput.value = '';
	}
}

function logoutAgent() {
	localStorage.removeItem('agentToken');
	localStorage.removeItem('agentId');
	localStorage.removeItem('agentUsername');
	socket.disconnect(); // Disconnect socket explicitly
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

async function populateOtherAgentsDropdown(currentChatSessionId) {
	otherAgentsDropdown.innerHTML = '';
	try {
		console.log('[Agent Script] Populating invite agent dropdown...');
		const response = await fetch('/api/agents/all', { // Fetch all agents for the dropdown
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[Agent Script] Failed to fetch agents for dropdown: HTTP status ${response.status}, Response: ${errorText}`);
			throw new Error('Failed to fetch agents for dropdown');
		}
		const allAgents = await response.json();
		const currentSessionInfo = sessionDataMap.get(currentChatSessionId);
		// agentIds in currentSessionInfo are already strings
		const agentsInThisChat = currentSessionInfo ? currentSessionInfo.agentIds : [];
		console.log(`[Agent Script] All agents fetched:`, allAgents);
		console.log(`[Agent Script] Agents already in current chat (as strings):`, agentsInThisChat);


		allAgents.forEach(agent => {
			// Only show agents that are not the current agent and not already in this chat
			// agent._id is a string, agentsInThisChat contains strings
			if (agent._id !== agentId && !agentsInThisChat.includes(agent._id)) {
				const a = document.createElement('a');
				a.href = '#';
				a.textContent = agent.username;
				a.setAttribute('data-agent-id', agent._id);
				a.addEventListener('click', (e) => {
					e.preventDefault();
					socket.emit('agent:invite_agent', { sessionId: activeSessionId, invitedAgentId: agent._id });
					console.log(`[Agent Script] Emitted agent:invite_agent for session ${activeSessionId}, invited: ${agent.username}`);
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
		console.log(`[Agent Script] Dropdown populated with ${otherAgentsDropdown.children.length} agents.`);


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
if (agentUsernameSpan) { // This check ensures we're on the dashboard page
	setAvailableBtn.addEventListener('click', () => setAgentStatus('available'));
	setUnavailableBtn.addEventListener('click', () => setAgentStatus('unavailable'));
	sendAgentMessageButton.addEventListener('click', sendAgentMessage);
	agentMessageInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			sendMessageButton.click();
		}
	});
	closeChatButton.addEventListener('click', () => {
		if (activeSessionId && confirm('Are you sure you want to close this chat session?')) {
			socket.emit('agent:close_chat', activeSessionId);
		}
	});
	if (leaveChatButton) {
		leaveChatButton.addEventListener('click', () => {
			if (activeSessionId && confirm('Are you sure you want to leave this chat?')) {
				socket.emit('agent:leave_chat', { sessionId: activeSessionId });
				activeSessionId = null; // Clear active chat
				agentChatArea.style.display = 'none';
				welcomeHeader.style.display = 'none';
				noChatSelectedDiv.style.display = 'block';
				// No need to clear sessionDataMap entry here, loadChatSessions will refresh
			}
		});
	}

	// Initial load logic for agent dashboard
	if (!agentToken || !agentId || !agentUsername) {
		window.location.href = '/agent_login.html';
	} else {
		agentUsernameSpan.textContent = agentUsername;
		agentIdSpan.textContent = agentId;
		// Authenticate socket connection with agent ID
		socket.emit('agent:authenticate', agentId);
		// Load initial chat sessions data
		loadChatSessions();
	}
}


// --- Socket.IO Listeners (for agent_dashboard.html) ---

socket.on('agent:initial_dashboard_data', ({ pendingAndAssignedChats, agentStatus }) => {
	console.log('[Agent Socket] agent:initial_dashboard_data received.');
	myAgentStatus.textContent = agentStatus.charAt(0).toUpperCase() + agentStatus.slice(1);
	currentAgentStatus = agentStatus;
	updateStatusButtonHighlight();

	chatSessionsList.innerHTML = ''; // Clear list before re-populating
	sessionDataMap.clear(); // Clear map to reflect server's current state accurately

	pendingAndAssignedChats.forEach(session => {
		const hasNew = (session.status === 'in_queue'); // Only new if it's in queue
		// IMPORTANT: agentIds are already strings from the server-side event payload
		sessionDataMap.set(session._id, {
			customerName: session.customerName,
			topic: session.topic,
			messages: [], // Clear messages, will fetch on open
			status: session.status,
			hasNewMessage: hasNew,
			agentIds: session.agentIds || [], // Now guaranteed to be strings
			agentUsernames: session.agentUsernames || []
		});
		renderChatSessionListItem(session);
	});
});

socket.on('agent:status_updated', ({ userId, status }) => {
	console.log(`[Agent Socket] agent:status_updated received for ${userId}: ${status}`);
	if (userId === agentId) {
		myAgentStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
		currentAgentStatus = status;
		updateStatusButtonHighlight();
	}
});

socket.on('agent:new_queue_item', ({ sessionId, customerName }) => {
	console.log(`[Agent Socket] agent:new_queue_item received for session ${sessionId}, customer ${customerName}.`);
	sessionDataMap.set(sessionId, {
		customerName: customerName,
		topic: 'New Customer Request', // Default topic for queued
		messages: [],
		status: 'in_queue',
		hasNewMessage: true,
		agentIds: [], // New queue items won't have agents yet
		agentUsernames: []
	});
	loadChatSessions(); // Re-render the list to show the new item
});

socket.on('agent:chat_assigned_to_me', async ({ sessionId, customerName, topic }) => {
	console.log(`[Agent Socket] agent:chat_assigned_to_me received for session ${sessionId}.`);
	// This event means YOU were assigned or took a chat from queue
	// The agent:session_status_changed will follow and update the actual agentIds/Usernames.
	let sessionInfo = sessionDataMap.get(sessionId);
	if (sessionInfo) {
		sessionInfo.status = 'assigned';
		sessionInfo.hasNewMessage = true;
	} else {
		// agentIds and agentUsernames will be updated by 'agent:session_status_changed'
		sessionDataMap.set(sessionId, {
			customerName, topic, messages: [], status: 'assigned', hasNewMessage: true, agentIds: [], agentUsernames: []
		});
	}

	await loadChatSessions(); // Reload to refresh list item status/highlight

	// If no chat is currently active, auto-open this new chat
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
		// If another chat is active, just highlight this one as new
		const li = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
		if (li) {
			li.classList.add('has-new-message');
		}
	}
});

socket.on('agent:session_status_changed', ({ sessionId, newStatus, agentIds, agentUsernames }) => {
	console.log(`[Agent Socket] agent:session_status_changed received for session ${sessionId}. New Status: ${newStatus}, Agent Usernames: ${agentUsernames.join(', ')}.`);
	if (sessionDataMap.has(sessionId)) {
		const sessionInfo = sessionDataMap.get(sessionId);
		sessionInfo.status = newStatus;
		// agentIds from server are now strings
		sessionInfo.agentIds = agentIds || [];
		sessionInfo.agentUsernames = agentUsernames; // Update with the new list of agent usernames
	}
	loadChatSessions(); // Re-render list to reflect status and agent changes
	if (activeSessionId === sessionId) {
		// If this is the active chat, update the displayed agent names and dropdown
		currentChatCustomerNameSpan.textContent = sessionDataMap.get(sessionId)?.customerName || ''; // Re-set customer name
		populateOtherAgentsDropdown(sessionId); // Refresh invite dropdown
	}
});


socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp, senderUsername }) => {
	console.log(`[Agent Socket] chat:message received for session ${sessionId}. Sender: ${senderUsername} (${senderId}), Role: ${senderRole}, Content: "${content}"`);
	if (sessionId === activeSessionId) {
		// Only append if it's not a message sent by this agent's own client (avoid duplicates)
		if (!(senderRole === 'agent' && senderId === agentId)) {
			appendAgentMessage(senderId, content, senderRole, senderUsername);
		} else {
			console.log('[Agent Socket] Ignoring self-sent message for active session.');
		}
	} else {
		console.log(`[Agent Socket] Message for inactive session ${sessionId}. Marking new.`);
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
	console.log(`[Agent Socket] chat:agent_joined received. Agent: ${joinedAgentUsername}, All Agents: ${allAgentNames.join(', ')}`);
	if (sessionId === activeSessionId) {
		if (sessionDataMap.has(sessionId)) {
			// Update agentIds and agentUsernames in map for the active session
			const sessionInfo = sessionDataMap.get(sessionId);
			// joinedAgentId is already a string from server
			sessionInfo.agentIds = sessionInfo.agentIds.includes(joinedAgentId) ? sessionInfo.agentIds : [...sessionInfo.agentIds, joinedAgentId];
			sessionInfo.agentUsernames = allAgentNames; // Make sure this is updated
		}
		appendAgentMessage('System', `${joinedAgentUsername} has joined this chat.`, 'system');
		populateOtherAgentsDropdown(sessionId); // Refresh dropdown as agents list has changed
	}
	loadChatSessions(); // Refresh list to update agent names there too
});

socket.on('chat:agent_left', ({ sessionId, agentId: leftAgentId, agentUsername: leftAgentUsername, allAgentNames }) => {
	console.log(`[Agent Socket] chat:agent_left received. Agent: ${leftAgentUsername}, All Agents: ${allAgentNames.join(', ')}`);
	if (sessionId === activeSessionId) {
		if (sessionDataMap.has(sessionId)) {
			const sessionInfo = sessionDataMap.get(sessionId);
			// leftAgentId is already a string from server
			sessionInfo.agentIds = sessionInfo.agentIds.filter(id => id !== leftAgentId);
			sessionInfo.agentUsernames = allAgentNames;
		}
		appendAgentMessage('System', `${leftAgentUsername} has left the chat.`, 'system');
		populateOtherAgentsDropdown(sessionId); // Refresh dropdown as agents list has changed
	}
	loadChatSessions(); // Refresh list to update agent names there too
});

// NEW: Listener for when this agent is invited to a chat
socket.on('agent:you_were_invited', ({ sessionId, customerName, topic, invitingAgentUsername, agentIds, agentUsernames }) => {
	console.log(`[Agent Socket] agent:you_were_invited received for session ${sessionId}. Inviting agent: ${invitingAgentUsername}`);
	// Update sessionDataMap to mark this chat as new/assigned
	// agentIds from server are already strings for this event
	sessionDataMap.set(sessionId, {
		customerName: customerName,
		topic: topic,
		messages: [], // Clear messages, will fetch on open
		status: 'assigned', // It's now assigned to you (or you're joining)
		hasNewMessage: true, // Mark for red dot
		agentIds: agentIds || [], // Now guaranteed to be strings
		agentUsernames: agentUsernames || [] // Update with provided agent usernames
	});
	loadChatSessions(); // Reload list to show highlight

	// Display an on-screen notification
	alert(`You've been invited to a chat with ${customerName} by ${invitingAgentUsername}! Topic: "${topic}"`);
});


socket.on('agent:session_closed_broadcast', ({ sessionId }) => {
	console.log(`[Agent Socket] Session ${sessionId} closed broadcast received. Reloading sessions.`);
	sessionDataMap.delete(sessionId); // Remove from map
	loadChatSessions(); // Re-render the list

	if (activeSessionId === sessionId) {
		activeSessionId = null; // Clear active session
		agentChatArea.style.display = 'none';
		welcomeHeader.style.display = 'none';
		noChatSelectedDiv.style.display = 'block'; // Show "No chat selected"
	}
});

socket.on('chat:session_closed', ({ sessionId, reason }) => {
	console.log(`[Agent Socket] chat:session_closed received for session ${sessionId}. Reason: ${reason}`);
	// This is primarily for the agent currently viewing the chat
	if (sessionId === activeSessionId) {
		appendAgentMessage('System', `Chat session closed. Reason: ${reason.replace('_', ' ')}.`, 'system');
		// The agent:session_closed_broadcast will handle UI changes like hiding the chat area.
	}
});

socket.on('agent:queue_updated', () => {
	console.log('[Agent Socket] Queue updated. Reloading sessions.');
	loadChatSessions(); // Re-fetch and re-render sessions, including queue changes
});

socket.on('agent:online_status', ({ userId, isOnline, status }) => {
	console.log(`[Agent Socket] Agent online status received for ${userId}: isOnline=${isOnline}, status=${status}`);
	// You could potentially use this to update a list of all agents' online status if you have one.
});

socket.on('auth_error', (message) => {
	console.error(`[Agent Socket] Authentication Error: ${message}`);
	alert(`Authentication Error: ${message}. Please log in again.`);
	logoutAgent();
});

socket.on('disconnect', () => {
	console.log('[Agent Socket] Disconnected from server.');
	myAgentStatus.textContent = 'Disconnected';
	myAgentStatus.style.color = 'red';
	// The server-side grace period will handle real offline status
});

socket.on('reconnect', () => {
	console.log('[Agent Socket] Reconnected to server. Re-authenticating...');
	// Upon reconnection, re-authenticate to rejoin rooms and get fresh dashboard data
	if (agentId) {
		socket.emit('agent:authenticate', agentId);
	} else {
		// Should not happen if agentId is in localStorage, but safety check
		logoutAgent();
	}
	myAgentStatus.style.color = ''; // Reset color
});