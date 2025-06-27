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


let agentToken = localStorage.getItem('agentToken');
let agentId = localStorage.getItem('agentId');
let agentUsername = localStorage.getItem('agentUsername');
let currentAgentStatus = null; // To track agent's availability status
let activeSessionId = null; // The sessionId currently open in the chat window

// Map to store session details by sessionId for quick lookup
const sessionDataMap = new Map(); // sessionId -> { customerName, topic, messages: [], hasNewMessage: boolean }

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

// Function to update agent status via API
async function setAgentStatus(status) {
	try {
		const response = await fetch('/api/agents/status', {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${agentToken}`
			},
			body: JSON.stringify({ status })
		});
		const data = await response.json();
		if (response.ok) {
			// Status will be updated via socket event 'agent:status_updated'
			console.log(data.msg);
		} else {
			alert(data.msg || 'Failed to update status.');
		}
	} catch (error) {
		console.error('Error setting agent status:', error);
		alert('Could not update status. Server error.');
	}
}

// Function to load and display chat sessions
async function loadChatSessions() {
	try {
		console.log('Fetching chat sessions...');
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
		console.log('API returned sessions:', sessions);

		chatSessionsList.innerHTML = ''; // Clear current list
		console.log('Chat list cleared.');

		sessions.forEach(session => {
			console.log('Rendering session:', session._id, session.customerName, session.status);
			// Preserve hasNewMessage flag if exists
			const existingSessionInfo = sessionDataMap.get(session._id);
			sessionDataMap.set(session._id, {
				customerName: session.customerName,
				topic: session.topic,
				messages: existingSessionInfo ? existingSessionInfo.messages : [],
				status: session.status,
				hasNewMessage: existingSessionInfo ? existingSessionInfo.hasNewMessage : false
			});
			renderChatSessionListItem(session);
		});
		console.log('Finished rendering sessions.');
		return sessions; // Return sessions for further processing
	} catch (error) {
		console.error('Error loading chat sessions:', error);
		alert('Failed to load chat sessions.');
		return [];
	}
}

function renderChatSessionListItem(session) {
	const li = document.createElement('li');
	li.setAttribute('data-session-id', session._id);
	// Determine if it should be highlighted immediately
	if (session._id === activeSessionId) {
		li.classList.add('active-chat');
	}
	// Check if there are new messages for this session
	// FIXED: Removed unconditional add class here
	if (sessionDataMap.has(session._id) && sessionDataMap.get(session._id).hasNewMessage) {
		li.classList.add('has-new-message');
	}

	li.innerHTML = `
        <strong>${session.customerName}</strong>
        <span>${session.topic}</span>
        <span style="font-size: 0.8em; color: #aab; margin-top: 5px;">Status: ${session.status.replace('_', ' ')}</span>
    `;
	// MODIFIED: Add click handler to open chat and for pending/in_queue, emit agent:accept_chat
	li.addEventListener('click', () => {
		if (session.status === 'pending' || session.status === 'in_queue') {
			// If it's a pending/queued chat, the agent is accepting it
			socket.emit('agent:accept_chat', { sessionId: session._id });
			console.log(`Agent attempting to accept chat: ${session._id}`);

			// NEW: Immediately update UI to show chat as selected and open it
			// This sets activeSessionId and triggers display of chat area
			openChatSession(session._id);
			// Also, manually add 'active-chat' class to this LI
			const currentSelected = document.querySelector('.chat-list li.active-chat');
			if (currentSelected) {
				currentSelected.classList.remove('active-chat');
			}
			li.classList.add('active-chat');
			li.classList.remove('has-new-message'); // Clear notification visually

			// The server will then update status and re-broadcast, triggering loadChatSessions
			// which will re-render the list, but our active chat will already be set.
		} else if (session.status === 'assigned' && session.agentId === agentId) {
			// If already assigned to this agent, just open it
			openChatSession(session._id);
		} else if (session.status === 'assigned' && session.agentId !== agentId) {
			// Optional: Handle case where agent tries to open a chat assigned to another agent
			alert('This chat is assigned to another agent.');
		}
	});
	chatSessionsList.appendChild(li);
}

async function openChatSession(sessionId) {
	// Clear previous active chat styling
	const previouslyActive = document.querySelector('.chat-list li.active-chat');
	if (previouslyActive) {
		previouslyActive.classList.remove('active-chat');
	}

	// Set new active chat styling
	const currentActive = document.querySelector(`li[data-session-id="${sessionId}"]`);
	if (currentActive) {
		currentActive.classList.add('active-chat');
		currentActive.classList.remove('has-new-message'); // Clear notification
		// Clear new message flag in map
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

		// Fetch messages for this session
		await fetchAndDisplayMessages(sessionId);
	}
}

async function fetchAndDisplayMessages(sessionId) {
	agentChatMessagesDiv.innerHTML = ''; // Clear current messages
	try {
		const response = await fetch(`/api/chat_sessions/${sessionId}/messages`, {
			headers: { 'Authorization': `Bearer ${agentToken}` }
		});
		if (!response.ok) {
			throw new Error('Failed to fetch messages for session');
		}
		const messages = await response.json();
		sessionDataMap.get(sessionId).messages = messages; // Cache messages
		messages.forEach(msg => {
			appendAgentMessage(msg.senderId, msg.content, msg.senderRole);
		});
		agentChatMessagesDiv.scrollTop = agentChatMessagesDiv.scrollHeight;
	} catch (error) {
		console.error('Error fetching messages:', error);
		appendAgentMessage('System', 'Failed to load messages.', 'system');
	}
}

function appendAgentMessage(senderId, content, role) {
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble');

	let senderName = '';
	if (role === 'agent') {
		messageBubble.classList.add('sent');
		senderName = 'You'; // Current agent
	} else if (role === 'customer') {
		messageBubble.classList.add('received');
		// Try to get customer name from map, fallback to ID if not found
		const session = sessionDataMap.get(activeSessionId);
		senderName = session ? session.customerName : senderId;
	} else { // System messages
		messageBubble.classList.add('received');
		senderName = 'System';
	}
	messageBubble.innerHTML = `<strong>${senderName}:</strong> ${content}`;

	agentChatMessagesDiv.appendChild(messageBubble);
	agentChatMessagesDiv.scrollTop = agentChatMessagesDiv.scrollHeight;
}

async function sendAgentMessage() {
	const message = agentMessageInput.value.trim();
	if (message && activeSessionId) {
		socket.emit('agent:message', { sessionId: activeSessionId, content: message });
		// FIXED: Only append locally, do not re-append when received from server
		appendAgentMessage(agentId, message, 'agent'); // Append immediately
		agentMessageInput.value = '';
	}
}

function logoutAgent() {
	localStorage.removeItem('agentToken');
	localStorage.removeItem('agentId');
	localStorage.removeItem('agentUsername');
	socket.disconnect(); // Disconnect socket
	window.location.href = '/agent_login.html';
}

function updateStatusButtonHighlight() {
	// Remove active class from all buttons
	setAvailableBtn.classList.remove('active-status');
	setUnavailableBtn.classList.remove('active-status');

	// Add active class to the current status button
	if (currentAgentStatus === 'available') {
		setAvailableBtn.classList.add('active-status');
	} else if (currentAgentStatus === 'unavailable') {
		setUnavailableBtn.classList.add('active-status');
	}
	// 'chatting' status means they are implicitly available, but we don't have a button for it.
	// The current UI shows 'My Status: Chatting', but buttons remain for setting available/unavailable.
}

// --- Event Listeners and Initial Logic ---
// This block ensures elements exist before attaching listeners or calling functions that need them
if (agentUsernameSpan) {
	// Event Listeners for Dashboard Buttons
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

	// Initial setup when on dashboard
	if (!agentToken || !agentId || !agentUsername) {
		window.location.href = '/agent_login.html';
	} else {
		agentUsernameSpan.textContent = agentUsername;
		agentIdSpan.textContent = agentId;
		socket.emit('agent:authenticate', agentId);
		loadChatSessions(); // Initial load of chat sessions when dashboard is loaded
	}
}


// --- Socket.IO Listeners (for agent_dashboard.html) ---

// Initial data for dashboard on agent:authenticate
socket.on('agent:initial_dashboard_data', ({ pendingAndAssignedChats, agentStatus }) => {
	myAgentStatusSpan.textContent = agentStatus.charAt(0).toUpperCase() + agentStatus.slice(1);
	currentAgentStatus = agentStatus;
	updateStatusButtonHighlight();

	chatSessionsList.innerHTML = ''; // Clear existing
	pendingAndAssignedChats.forEach(session => {
		// MODIFIED: Set hasNewMessage to true for pending or in_queue sessions on initial load
		const hasNew = (session.status === 'pending' || session.status === 'in_queue');
		const existingSessionInfo = sessionDataMap.get(session._id);
		sessionDataMap.set(session._id, {
			customerName: session.customerName,
			topic: session.topic,
			messages: existingSessionInfo ? existingSessionInfo.messages : [],
			status: session.status,
			hasNewMessage: hasNew // Initialize based on status
		});
		renderChatSessionListItem(session);
	});
});

// Update agent status on the dashboard
socket.on('agent:status_updated', ({ userId, status }) => {
	if (userId === agentId) { // This agent's status
		myAgentStatusSpan.textContent = status.charAt(0).toUpperCase() + status.slice(1);
		currentAgentStatus = status;
		updateStatusButtonHighlight();
	}
	// You could also update status of other agents if you were displaying them
});

// New chat request arrived (in queue)
socket.on('agent:new_queue_item', ({ sessionId, customerName }) => {
	console.log(`New queue item: ${customerName}. Reloading sessions and marking new.`);
	// Set hasNewMessage for this session if it's new or update it
	sessionDataMap.set(sessionId, {
		customerName: customerName,
		topic: 'New Customer Request',
		messages: [],
		status: 'in_queue',
		hasNewMessage: true
	});
	loadChatSessions(); // Reload all sessions to ensure consistent list
});

// Chat assigned to THIS agent (either automatically or by another agent)
socket.on('agent:chat_assigned_to_me', async ({ sessionId, customerName, topic }) => {
	console.log(`Chat ${sessionId} assigned to me. Attempting to update list and open chat.`);

	// Update status in sessionDataMap
	let sessionInfo = sessionDataMap.get(sessionId);
	if (sessionInfo) {
		sessionInfo.status = 'assigned';
		sessionInfo.hasNewMessage = true; // Also mark as new
	} else {
		// If it was not in map (e.g., direct assignment without queue), add it
		sessionDataMap.set(sessionId, {
			customerName, topic, messages: [], status: 'assigned', hasNewMessage: true
		});
	}

	// This is fired when the chat is assigned (either automatically or manually accepted)
	// We already handle auto-opening if !activeSessionId.
	// The loadChatSessions and re-render will ensure it's displayed, and
	// if activeSessionId isn't set, the auto-open logic will fire.
	await loadChatSessions(); // Reload all sessions to ensure consistent list


	// Optionally auto-open the chat if agent not busy and the chat is now visible
	if (!activeSessionId) { // Only auto-open if no other chat is currently active
		// We'll wait a bit longer and check if the element is in the DOM
		let attempts = 0;
		const maxAttempts = 20; // Try for up to 2 seconds (20 * 100ms)
		const checkInterval = 100; // Check every 100ms

		const checkAndOpenChat = () => {
			const liElement = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
			if (liElement) {
				console.log(`Found LI element for session ${sessionId}. Opening chat automatically.`);
				openChatSession(sessionId); // This will set activeSessionId and render the chat area
			} else if (attempts < maxAttempts) {
				attempts++;
				console.log(`Attempt ${attempts}/${maxAttempts}: LI element not found for ${sessionId} during auto-open. Retrying...`);
				setTimeout(checkAndOpenChat, checkInterval);
			} else {
				console.warn(`Could not confirm chat session LI for ${sessionId} in DOM for auto-open. Manual selection may be needed.`);
			}
		};
		setTimeout(checkAndOpenChat, checkInterval); // Initial check after a short delay
	} else {
		// If another chat is active, just ensure notification is set for the new chat
		const li = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
		if (li) {
			li.classList.add('has-new-message'); // Indicate new chat
		}
	}
});


// NEW: Listener for when a session's status changes (e.g., pending -> assigned by another agent, or manual acceptance)
socket.on('agent:session_status_changed', ({ sessionId, newStatus, agentId: assignedAgentId, agentUsername: assignedAgentUsername }) => {
	console.log(`Session ${sessionId} status changed to ${newStatus}. Reloading sessions.`);
	// Update the session in the map
	if (sessionDataMap.has(sessionId)) {
		const sessionInfo = sessionDataMap.get(sessionId);
		sessionInfo.status = newStatus;
		if (newStatus === 'assigned') {
			sessionInfo.agentId = assignedAgentId;
			sessionInfo.agentUsername = assignedAgentUsername;
		}
	}
	loadChatSessions(); // Re-render the list with updated status
});


// General chat message (for the active chat)
socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp }) => {
	if (sessionId === activeSessionId) {
		// FIXED: Prevent duplicate appending for messages sent by this agent
		if (senderRole === 'agent' && senderId === agentId) {
			// This message was sent by *this* agent and was already appended locally. Ignore.
			return;
		}
		// Only append if it's the currently viewed chat
		appendAgentMessage(senderId, content, senderRole);
	} else {
		// Mark session in sidebar as having new message
		if (sessionDataMap.has(sessionId)) {
			sessionDataMap.get(sessionId).hasNewMessage = true;
		}
		const li = chatSessionsList.querySelector(`li[data-session-id="${sessionId}"]`);
		if (li) {
			li.classList.add('has-new-message');
			// Optionally, increment a message count badge here
		}
	}
});

// When a session is closed (by customer or agent, or disconnect)
socket.on('agent:session_closed_broadcast', ({ sessionId }) => {
	console.log(`Session ${sessionId} closed broadcast received. Reloading sessions.`);
	// Immediately remove from map, then reload to ensure list is accurate.
	sessionDataMap.delete(sessionId);
	loadChatSessions(); // Reload all sessions to ensure consistent list

	if (activeSessionId === sessionId) {
		// If the closed session was the active one, clear chat area
		activeSessionId = null;
		agentChatArea.style.display = 'none';
		welcomeHeader.style.display = 'none';
		noChatSelectedDiv.style.display = 'block';
	}
});

socket.on('chat:session_closed', ({ sessionId, reason }) => {
	// This is primarily for the client who initiated the close, or for disconnects
	// Agent side mainly relies on agent:session_closed_broadcast for UI updates
	if (sessionId === activeSessionId) {
		appendAgentMessage('System', `Chat session closed. Reason: ${reason.replace('_', ' ')}.`, 'system');
	}
});

// Update queue items (e.g., when a pending chat is assigned to another agent)
socket.on('agent:queue_updated', () => {
	console.log('Queue updated. Reloading sessions.');
	loadChatSessions(); // Re-fetch to ensure queue is accurate
});

// Broadcast online status of other agents (if we were to display them)
socket.on('agent:online_status', ({ userId, isOnline, status }) => {
	// console.log(`Agent ${userId} isOnline: ${isOnline}, Status: ${status}`);
	// Future: Update a list of other agents if displayed on dashboard
});
