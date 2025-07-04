// public/customer_script.js
const socket = io();

// --- Elements for customer_index.html ---
const chatRequestForm = document.getElementById('chatRequestForm');
const customerNameInput = document.getElementById('customerName');
const customerEmailInput = document.getElementById('customerEmail');
const topicInput = document.getElementById('topic');
const indexMessageDiv = document.getElementById('message');

// --- Elements for customer_chat.html ---
const chatContainer = document.querySelector('.chat-container');
const queueInfo = document.getElementById('queueInfo');
const queuePositionSpan = document.getElementById('queuePosition');
const cancelQueueButton = document.getElementById('cancelQueueButton');
const chatEndedInfo = document.getElementById('chatEndedInfo');
const chatEndedMessage = document.getElementById('chatEndedMessage');
const agentNamesSpan = document.getElementById('agentNames');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendMessageButton = document.getElementById('sendMessageButton');
const endChatButton = document.getElementById('endChatButton');

let currentSessionId = localStorage.getItem('currentSessionId'); // Load persisted session ID
let currentCustomerName = localStorage.getItem('customerName');
let currentCustomerId = localStorage.getItem('customerId'); // Will be set by server on request
let initialCustomerMessage = localStorage.getItem('topic');

// Function to navigate to the chat page
function goToChatPage() {
	window.location.href = '/customer_chat.html';
}

// Function to append messages to the chat interface
function appendMessage(sender, content, role) {
	const messageBubble = document.createElement('div');
	messageBubble.classList.add('message-bubble');

	if (role === 'customer') {
		messageBubble.classList.add('sent');
		messageBubble.innerHTML = `<strong>You:</strong> ${content}`;
	} else if (role === 'agent') {
		messageBubble.classList.add('received');
		messageBubble.innerHTML = `<strong>${sender}:</strong> ${content}`;
	} else { // System messages
		messageBubble.classList.add('received');
		messageBubble.innerHTML = `<strong>System:</strong> <em>${content}</em>`;
	}

	if (messagesDiv) { // Ensure messagesDiv exists before appending
		messagesDiv.appendChild(messageBubble);
		messagesDiv.scrollTop = messagesDiv.scrollHeight;
	}
}

// --- Event Handlers for customer_index.html ---
if (chatRequestForm) {
	chatRequestForm.addEventListener('submit', (e) => {
		e.preventDefault();
		console.log('[Customer Form] Form submitted.');
		const customerName = customerNameInput.value.trim();
		const customerEmail = customerEmailInput.value.trim();
		const topic = topicInput.value.trim(); // This is the initial message content

		if (customerName && topic) {
			localStorage.setItem('customerName', customerName);
			localStorage.setItem('customerEmail', customerEmail);
			localStorage.setItem('topic', topic); // Store topic as initial message
			console.log(`[Customer Form] Stored in localStorage: Name=${customerName}, Topic=${topic}`);
			goToChatPage();
		} else {
			indexMessageDiv.textContent = 'Please provide your name and issue.';
			indexMessageDiv.style.color = 'red';
			console.log('[Customer Form] Validation failed: Name or Topic missing.');
		}
	});
}

// --- Logic for customer_chat.html ---
if (chatContainer) {
	console.log('[Customer Chat Page] Loaded.');

	// Check for existing session on page load/refresh
	if (currentSessionId && currentCustomerId && currentCustomerName && initialCustomerMessage) {
		// Attempt to rejoin previous session
		console.log(`[Customer Chat Page] Attempting to rejoin session ${currentSessionId} for customer ${currentCustomerId}.`);
		socket.emit('customer:rejoin_chat', { sessionId: currentSessionId, customerId: currentCustomerId });
		chatContainer.style.display = 'none'; // Keep hidden until rejoin success
		queueInfo.style.display = 'block'; // Show queue info temporarily
		queuePositionSpan.textContent = 'Reconnecting...';
		chatEndedInfo.style.display = 'none';
		appendMessage('System', 'Reconnecting to your chat...', 'system');
	}
	else if (!currentCustomerName || !initialCustomerMessage) {
		console.log('[Customer Chat Page] Missing customer info in localStorage. Redirecting.');
		window.location.href = '/customer_index.html';
	} else {
		// This is a new chat request
		console.log(`[Customer Chat Page] New chat request: Name=${currentCustomerName}, Initial Message=${initialCustomerMessage}`);
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'block';
		chatEndedInfo.style.display = 'none';

		console.log('[Customer Chat Page] Emitting customer:request_chat...');
		// Only emit the chat request, server handles initial message
		socket.emit('customer:request_chat', { customerName: currentCustomerName, customerEmail: localStorage.getItem('customerEmail'), topic: initialCustomerMessage });
		appendMessage('System', 'Connecting to support...', 'system');
	}

	sendMessageButton.addEventListener('click', () => {
		const message = messageInput.value.trim();
		if (message && currentSessionId) {
			console.log(`[Customer Chat] Sending message: "${message}" to session ${currentSessionId}`);
			socket.emit('customer:message', { sessionId: currentSessionId, content: message });
			appendMessage(currentCustomerName, message, 'customer'); // Optimistically add to UI
			messageInput.value = '';
		}
	});

	messageInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			sendMessageButton.click();
		}
	});

	endChatButton.addEventListener('click', () => {
		if (currentSessionId && confirm('Are you sure you want to end this chat?')) {
			console.log(`[Customer Chat] Ending chat for session ${currentSessionId}`);
			socket.emit('customer:close_chat_request', { sessionId: currentSessionId });
			appendMessage('System', 'You requested to end the chat.', 'system');
			// UI will be updated by chat:session_closed event
		}
	});

	cancelQueueButton.addEventListener('click', () => {
		if (currentSessionId && confirm('Are you sure you want to cancel your chat request?')) {
			console.log(`[Customer Chat] Cancelling queue for session ${currentSessionId}`);
			socket.emit('customer:cancel_queue', { sessionId: currentSessionId });
			appendMessage('System', 'You cancelled the chat request.', 'system');
			// UI will be updated by chat:session_closed event
		}
		// Note: localStorage cleared by chat:session_closed handler
	});
}


// --- Socket.IO Listeners (for customer_chat.html) ---

socket.on('chat:assigned', ({ sessionId, agentNames, customerId }) => {
	console.log(`[Customer Socket] chat:assigned received. Session ID: ${sessionId}, Agent Names: ${agentNames}, Customer ID: ${customerId}`);
	currentSessionId = sessionId;
	currentCustomerId = customerId; // Server sets this, so store it
	localStorage.setItem('currentSessionId', sessionId);
	localStorage.setItem('customerId', customerId); // Store customerId received from server

	agentNamesSpan.textContent = agentNames.join(', ');
	chatContainer.style.display = 'flex';
	queueInfo.style.display = 'none';
	chatEndedInfo.style.display = 'none';

	// Append system message about agent joining only if it's not a rejoin scenario where messages are already being loaded
	if (!initialCustomerMessage) { // Initial message cleared indicates not a fresh request, but a rejoin/assignment post initial setup
		if (agentNames.length === 1) {
			appendMessage('System', `${agentNames[0]} has joined the chat.`, 'system');
		} else if (agentNames.length > 1) {
			appendMessage('System', `You are now chatting with ${agentNames.join(', ')}.`, 'system');
		}
	}

	initialCustomerMessage = null; // Clear initial message flag after assignment/rejoin setup
});

socket.on('chat:queued', ({ position, sessionId, customerId }) => {
	console.log(`[Customer Socket] chat:queued received. Session ID: ${sessionId}, Position: ${position}, Customer ID: ${customerId}`);
	currentSessionId = sessionId;
	currentCustomerId = customerId; // Server sets this, so store it
	localStorage.setItem('currentSessionId', sessionId);
	localStorage.setItem('customerId', customerId); // Store customerId received from server

	queuePositionSpan.textContent = `No. ${position}`;
	chatContainer.style.display = 'none';
	queueInfo.style.display = 'block';
	chatEndedInfo.style.display = 'none';

	initialCustomerMessage = null; // Clear initial message flag after queued setup
});

socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp, senderUsername }) => {
	console.log(`[Customer Socket] chat:message received for session ${sessionId}. Sender: ${senderUsername} (${senderId}), Role: ${senderRole}, Content: "${content}"`);
	if (sessionId === currentSessionId) {
		// Avoid appending messages sent by this client already
		if (!(senderRole === 'customer' && senderId === currentCustomerId)) {
			let senderDisplayName = '';
			if (senderRole === 'customer') {
				senderDisplayName = currentCustomerName;
			} else if (senderRole === 'agent') {
				senderDisplayName = senderUsername; // Use the provided username
			}
			appendMessage(senderDisplayName, content, senderRole);
		} else {
			console.log('[Customer Socket] Ignoring self-sent message.');
		}
	}
});

socket.on('chat:agent_joined', ({ sessionId, agentId: joinedAgentId, agentUsername: joinedAgentUsername, allAgentNames }) => {
	console.log(`[Customer Socket] chat:agent_joined received. Agent: ${joinedAgentUsername}, All Agents: ${allAgentNames}`);
	if (sessionId === currentSessionId) {
		// Update the displayed agent names
		agentNamesSpan.textContent = allAgentNames.join(', ');
		// Only append system message if it's a *new* agent joining this session
		appendMessage('System', `${joinedAgentUsername} has joined the chat.`, 'system');
	}
});

socket.on('chat:agent_left', ({ sessionId, agentId: leftAgentId, agentUsername: leftAgentUsername, allAgentNames }) => {
	console.log(`[Customer Socket] chat:agent_left received. Agent: ${leftAgentUsername}, All Agents: ${allAgentNames}`);
	if (sessionId === currentSessionId) {
		agentNamesSpan.textContent = allAgentNames.join(', ');
		appendMessage('System', `${leftAgentUsername} has left the chat.`, 'system');
	}
});


socket.on('chat:session_closed', ({ sessionId, reason }) => {
	console.log(`[Customer Socket] chat:session_closed received. Session ID: ${sessionId}, Reason: ${reason}`);
	if (sessionId === currentSessionId) {
		currentSessionId = null;
		currentCustomerId = null;
		localStorage.removeItem('currentSessionId');
		localStorage.removeItem('customerId');
		localStorage.removeItem('customerName');
		localStorage.removeItem('customerEmail');
		localStorage.removeItem('topic');

		chatContainer.style.display = 'none';
		queueInfo.style.display = 'none';
		chatEndedInfo.style.display = 'block';

		let message = 'Your chat session has ended.';
		if (reason === 'agent_closed') {
			message = 'The agent has ended the chat session.';
		} else if (reason === 'customer_disconnected') {
			message = 'The chat session ended because you disconnected unexpectedly.';
		} else if (reason === 'agent_disconnected_last') {
			message = 'The last agent unexpectedly disconnected. Your chat session has ended.';
		} else if (reason === 'customer_cancelled_queue') {
			message = 'Your chat request has been cancelled.';
		} else if (reason === 'agent_left_last') {
			message = 'The last agent left the chat. Your chat session has ended.';
		} else if (reason === 'rejoin_failed') {
			message = 'Could not rejoin your previous chat session. It may have ended.';
		} else if (reason === 'rejoin_error') {
			message = 'An error occurred while rejoining your chat. It may have ended.';
		}
		chatEndedMessage.textContent = message;
	}
});

socket.on('disconnect', () => {
	console.log('[Customer Socket] Disconnected from server.');
	// If a chat is active, show a temporary message. Reconnect will try to fix.
	if (currentSessionId && chatContainer.style.display === 'flex') {
		appendMessage('System', 'Connection lost. Attempting to reconnect...', 'system');
	}
	// Do NOT clear localStorage here, as reconnect might happen
});

socket.on('reconnect', () => {
	console.log('[Customer Socket] Reconnected to server.');
	const storedCustomerName = localStorage.getItem('customerName');
	const storedTopic = localStorage.getItem('topic');
	const storedSessionId = localStorage.getItem('currentSessionId');
	const storedCustomerId = localStorage.getItem('customerId');

	// If there was an ongoing session, try to rejoin it
	if (storedSessionId && storedCustomerId && storedCustomerName && storedTopic) {
		console.log('[Customer Socket] Found stored session, attempting to rejoin.');
		socket.emit('customer:rejoin_chat', { sessionId: storedSessionId, customerId: storedCustomerId });
	} else {
		// If no session data, ensure we are on the correct start page
		if (window.location.pathname !== '/customer_index.html') {
			appendMessage('System', 'Reconnected, but no active chat to resume. Please start a new chat.', 'system');
			// Option: Redirect back to index or show specific message
			// window.location.href = '/customer_index.html';
		}
	}
});