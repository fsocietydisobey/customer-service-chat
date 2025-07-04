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
const agentNamesSpan = document.getElementById('agentNames'); // MODIFIED: agentNames (plural)
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendMessageButton = document.getElementById('sendMessageButton');
const endChatButton = document.getElementById('endChatButton');

let currentSessionId = null;
let currentCustomerName = null;
let currentCustomerId = null;
let initialCustomerMessage = null; // NEW: Store initial message

// Function to navigate to the chat page
function goToChatPage() {
	// FIXED: Redirect to customer_chat.html
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
		// FIXED: Use sender's username from payload, not just first agent in header
		messageBubble.innerHTML = `<strong>${sender}:</strong> ${content}`;
	} else { // System messages
		messageBubble.classList.add('received');
		messageBubble.innerHTML = `<strong>System:</strong> <em>${content}</em>`;
	}

	messagesDiv?.appendChild(messageBubble);
	if (messagesDiv) {
		messagesDiv.scrollTop = messagesDiv.scrollHeight;
	}
}

// --- Event Handlers for customer_index.html ---
if (chatRequestForm) {
	chatRequestForm.addEventListener('submit', (e) => {
		e.preventDefault();
		console.log('[Customer Form] Form submitted.'); // Debug log
		const customerName = customerNameInput.value.trim();
		const customerEmail = customerEmailInput.value.trim();
		const topic = topicInput.value.trim(); // This is the initial message content

		if (customerName && topic) {
			localStorage.setItem('customerName', customerName);
			localStorage.setItem('customerEmail', customerEmail);
			localStorage.setItem('topic', topic); // Store topic as initial message
			console.log(`[Customer Form] Stored in localStorage: Name=${customerName}, Topic=${topic}`); // Debug log
			goToChatPage();
		} else {
			indexMessageDiv.textContent = 'Please provide your name and issue.';
			indexMessageDiv.style.color = 'red';
			console.log('[Customer Form] Validation failed: Name or Topic missing.'); // Debug log
		}
	});
}

// --- Logic for customer_chat.html ---
if (chatContainer) {
	console.log('[Customer Chat Page] Loaded.'); // Debug log
	currentCustomerName = localStorage.getItem('customerName');
	const customerEmail = localStorage.getItem('customerEmail');
	initialCustomerMessage = localStorage.getItem('topic'); // Retrieve initial message

	if (!currentCustomerName || !initialCustomerMessage) { // Check for initial message
		console.log('[Customer Chat Page] Missing customer info in localStorage. Redirecting.'); // Debug log
		window.location.href = '/customer_index.html';
	} else {
		console.log(`[Customer Chat Page] Customer info found: Name=${currentCustomerName}, Initial Message=${initialCustomerMessage}`); // Debug log
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'block';
		chatEndedInfo.style.display = 'none';

		console.log('[Customer Chat Page] Emitting customer:request_chat...'); // Debug log
		// Only emit the chat request, the initial message is handled server-side upon session creation
		socket.emit('customer:request_chat', { customerName: currentCustomerName, customerEmail, topic: initialCustomerMessage });
		appendMessage('System', 'Connecting to support...', 'system');
		// Do NOT append initialCustomerMessage here, it will be sent via socket.emit('customer:message') later
	}

	sendMessageButton.addEventListener('click', () => {
		const message = messageInput.value.trim();
		if (message && currentSessionId) {
			console.log(`[Customer Chat] Sending message: "${message}" to session ${currentSessionId}`); // Debug log
			socket.emit('customer:message', { sessionId: currentSessionId, content: message });
			appendMessage(currentCustomerName, message, 'customer');
			messageInput.value = '';
		}
	});

	messageInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') {
			sendMessageButton.click();
		}
	});

	endChatButton.addEventListener('click', () => {
		if (currentSessionId) {
			console.log(`[Customer Chat] Ending chat for session ${currentSessionId}`); // Debug log
			socket.emit('customer:close_chat_request', { sessionId: currentSessionId });
			appendMessage('System', 'You requested to end the chat.', 'system');
		}
	});

	cancelQueueButton.addEventListener('click', () => {
		if (currentSessionId) {
			console.log(`[Customer Chat] Cancelling queue for session ${currentSessionId}`); // Debug log
			socket.emit('customer:cancel_queue', { sessionId: currentSessionId });
			appendMessage('System', 'You cancelled the chat request.', 'system');
		}
		localStorage.removeItem('customerName');
		localStorage.removeItem('customerEmail');
		localStorage.removeItem('topic');
		console.log('[Customer Chat] Cleared localStorage and transitioning to chat ended.'); // Debug log
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'none';
		chatEndedInfo.style.display = 'block';
		chatEndedMessage.textContent = 'Your chat request has been cancelled.';
	});
}


// --- Socket.IO Listeners (for customer_chat.html) ---

socket.on('chat:assigned', ({ sessionId, agentNames, customerId }) => {
	console.log(`[Customer Socket] chat:assigned received. Session ID: ${sessionId}, Agent Names: ${agentNames}, Customer ID: ${customerId}`); // Debug log
	currentSessionId = sessionId;
	currentCustomerId = customerId;
	agentNamesSpan.textContent = agentNames.join(', ');
	chatContainer.style.display = 'flex';
	queueInfo.style.display = 'none';
	chatEndedInfo.style.display = 'none';

	if (agentNames.length === 1) {
		appendMessage('System', `${agentNames[0]} has joined the chat.`, 'system');
	} else if (agentNames.length > 1) {
		appendMessage('System', `You are now chatting with ${agentNames.join(', ')}.`, 'system');
	}

	localStorage.setItem('currentSessionId', sessionId);

	// FIXED: Do NOT send initial message here. It's saved server-side on customer:request_chat.
	// initialCustomerMessage will be displayed when chat:message event for it is received.
	initialCustomerMessage = null; // Clear it so it's not sent again if reconnected
});

socket.on('chat:queued', ({ position, sessionId, customerId }) => {
	console.log(`[Customer Socket] chat:queued received. Session ID: ${sessionId}, Position: ${position}, Customer ID: ${customerId}`); // Debug log
	currentSessionId = sessionId;
	currentCustomerId = customerId;
	queuePositionSpan.textContent = `No. ${position}`;
	chatContainer.style.display = 'none';
	queueInfo.style.display = 'block';
	chatEndedInfo.style.display = 'none';

	// FIXED: Do NOT send initial message here. It's saved server-side on customer:request_chat.
	// initialCustomerMessage will be displayed when chat:message event for it is received.
	initialCustomerMessage = null; // Clear it so it's not sent again if reconnected
});

socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp, senderUsername }) => {
	console.log(`[Customer Socket] chat:message received for session ${sessionId}. Sender: ${senderUsername} (${senderId}), Role: ${senderRole}, Content: "${content}"`); // Debug log
	if (sessionId === currentSessionId) {
		if (senderRole === 'customer' && senderId === currentCustomerId) {
			console.log('[Customer Socket] Ignoring self-sent message.'); // Debug log
			return;
		}

		let senderDisplayName = '';
		if (senderRole === 'customer') {
			senderDisplayName = currentCustomerName;
		} else if (senderRole === 'agent') {
			senderDisplayName = senderUsername;
		}
		appendMessage(senderDisplayName, content, senderRole);
	}
});

socket.on('chat:agent_joined', ({ sessionId, agentId: joinedAgentId, agentUsername: joinedAgentUsername, allAgentNames }) => {
	console.log(`[Customer Socket] chat:agent_joined received. Agent: ${joinedAgentUsername}, All Agents: ${allAgentNames}`); // Debug log
	if (sessionId === currentSessionId) {
		const currentDisplayedAgents = agentNamesSpan.textContent.split(', ').map(name => name.trim());
		if (!currentDisplayedAgents.includes(joinedAgentUsername)) {
			appendMessage('System', `${joinedAgentUsername} has joined the chat.`, 'system');
		}
		agentNamesSpan.textContent = allAgentNames.join(', ');
	}
});

socket.on('chat:agent_left', ({ sessionId, agentId: leftAgentId, agentUsername: leftAgentUsername, allAgentNames }) => {
	console.log(`[Customer Socket] chat:agent_left received. Agent: ${leftAgentUsername}, All Agents: ${allAgentNames}`); // Debug log
	if (sessionId === currentSessionId) {
		agentNamesSpan.textContent = allAgentNames.join(', ');
		appendMessage('System', `${leftAgentUsername} has left the chat.`, 'system');
	}
});


socket.on('chat:session_closed', ({ sessionId, reason }) => {
	console.log(`[Customer Socket] chat:session_closed received. Session ID: ${sessionId}, Reason: ${reason}`); // Debug log
	if (sessionId === currentSessionId) {
		currentSessionId = null;
		currentCustomerId = null;
		localStorage.removeItem('currentSessionId');
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
			message = 'The chat session ended because you disconnected.';
		} else if (reason === 'agent_disconnected_last') {
			message = 'The last agent unexpectedly disconnected. Your chat session has ended.';
		} else if (reason === 'customer_cancelled_queue') {
			message = 'Your chat request has been cancelled.';
		} else if (reason === 'agent_left_last') {
			message = 'The last agent left the chat. Your chat session has ended.';
		}
		chatEndedMessage.textContent = message;
	}
});

socket.on('disconnect', () => {
	console.log('[Customer Socket] Disconnected from server.'); // Debug log
	if (currentSessionId && chatContainer.style.display === 'flex') {
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'none';
		chatEndedInfo.style.display = 'block';
		chatEndedMessage.textContent = 'Disconnected from the server. Your chat session might have ended.';
		currentSessionId = null;
		currentCustomerId = null;
		localStorage.removeItem('currentSessionId');
		localStorage.removeItem('customerName');
		localStorage.removeItem('customerEmail');
		localStorage.removeItem('topic');
	}
});

socket.on('reconnect', () => {
	console.log('[Customer Socket] Reconnected to server.'); // Debug log
	const storedCustomerName = localStorage.getItem('customerName');
	const storedEmail = localStorage.getItem('customerEmail');
	const storedTopic = localStorage.getItem('topic');
	const storedSessionId = localStorage.getItem('currentSessionId');

	if (storedCustomerName && storedTopic) {
		if (storedSessionId) {
			// In a real app, you'd try to rejoin the session here.
			// For now, we assume disconnect means chat ended from customer side.
		}
	}
});
