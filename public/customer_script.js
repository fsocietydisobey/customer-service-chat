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
const agentNameSpan = document.getElementById('agentName');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendMessageButton = document.getElementById('sendMessageButton');
const endChatButton = document.getElementById('endChatButton');

let currentSessionId = null;
let currentCustomerName = null;
let currentCustomerId = null; // Stored from server on chat:assigned/queued

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

	messagesDiv?.appendChild(messageBubble);
	// Ensure messagesDiv exists before attempting to set scrollTop
	if (messagesDiv) {
		messagesDiv.scrollTop = messagesDiv.scrollHeight; // Scroll to bottom
	}
}

// --- Event Handlers for customer_index.html ---
if (chatRequestForm) {
	chatRequestForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const customerName = customerNameInput.value.trim();
		const customerEmail = customerEmailInput.value.trim();
		const topic = topicInput.value.trim();

		if (customerName && topic) {
			localStorage.setItem('customerName', customerName);
			localStorage.setItem('customerEmail', customerEmail);
			localStorage.setItem('topic', topic);
			// Don't emit directly, redirect to chat page first.
			// The chat page will then handle the socket connection and chat request.
			goToChatPage();
		} else {
			indexMessageDiv.textContent = 'Please provide your name and issue.';
			indexMessageDiv.style.color = 'red';
		}
	});
}

// --- Logic for customer_chat.html ---
if (chatContainer) {
	// On page load for chat.html, retrieve details from localStorage
	currentCustomerName = localStorage.getItem('customerName');
	const customerEmail = localStorage.getItem('customerEmail');
	const topic = localStorage.getItem('topic');

	if (!currentCustomerName || !topic) {
		// If no pre-chat info, redirect back to index
		window.location.href = '/customer_index.html';
	} else {
		// Show queue info initially
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'block';
		chatEndedInfo.style.display = 'none';

		// Request chat from server
		socket.emit('customer:request_chat', { customerName: currentCustomerName, customerEmail, topic });
		appendMessage('System', 'Connecting to support...', 'system');
	}

	sendMessageButton.addEventListener('click', () => {
		const message = messageInput.value.trim();
		if (message && currentSessionId) {
			socket.emit('customer:message', { sessionId: currentSessionId, content: message });
			// Only append the message locally here. Do NOT re-append when received from server.
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
			socket.emit('customer:close_chat_request', { sessionId: currentSessionId });
			// The 'chat:session_closed' event from server will handle UI updates
			appendMessage('System', 'You requested to end the chat.', 'system');
		}
	});

	cancelQueueButton.addEventListener('click', () => {
		if (currentSessionId) {
			socket.emit('customer:cancel_queue', { sessionId: currentSessionId });
			// UI will be updated by 'chat:session_closed' event
			appendMessage('System', 'You cancelled the chat request.', 'system');
		}
		localStorage.removeItem('customerName');
		localStorage.removeItem('customerEmail');
		localStorage.removeItem('topic');
		// Transition to chat ended view
		chatContainer.style.display = 'none';
		queueInfo.style.display = 'none';
		chatEndedInfo.style.display = 'block';
		chatEndedMessage.textContent = 'Your chat request has been cancelled.';
	});
}


// --- Socket.IO Listeners (for customer_chat.html) ---

socket.on('chat:assigned', ({ sessionId, agentName, customerId }) => { // ADDED customerId
	currentSessionId = sessionId;
	currentCustomerId = customerId; // STORE customerId upon assignment
	agentNameSpan.textContent = agentName;
	chatContainer.style.display = 'flex'; // Show chat interface
	queueInfo.style.display = 'none';    // Hide queue info
	chatEndedInfo.style.display = 'none';
	appendMessage('System', `${agentName} has joined the chat.`, 'system');
	// Save currentSessionId to localStorage in case of refresh (optional, more complex state management)
	localStorage.setItem('currentSessionId', sessionId);
});

socket.on('chat:queued', ({ position, sessionId, customerId }) => { // ADDED customerId
	currentSessionId = sessionId; // Store session ID for the queued state
	currentCustomerId = customerId; // STORE customerId upon queueing
	queuePositionSpan.textContent = `No. ${position}`;
	chatContainer.style.display = 'none';
	queueInfo.style.display = 'block';
	chatEndedInfo.style.display = 'none';
});

socket.on('chat:message', ({ sessionId, senderId, senderRole, content, timestamp }) => {
	if (sessionId === currentSessionId) {
		// FIXED: Prevent duplicate appending for messages sent by this customer
		if (senderRole === 'customer' && senderId === currentCustomerId) {
			// This message was sent by *this* client and was already appended locally. Ignore.
			return;
		}

		let senderName = '';
		if (senderRole === 'customer') {
			// This case should ideally only be for messages from other customer sockets (if multi-customer chat)
			// or if initial local append was skipped. For one-to-one customer, this means it's the other party.
			senderName = currentCustomerName; // It's "You" but from another source
		} else if (senderRole === 'agent') {
			senderName = agentNameSpan.textContent; // Currently assigned agent's name
		}
		appendMessage(senderName, content, senderRole);
	}
});

socket.on('chat:session_closed', ({ sessionId, reason }) => {
	if (sessionId === currentSessionId) {
		currentSessionId = null; // Clear session ID
		currentCustomerId = null; // Clear customer ID
		localStorage.removeItem('currentSessionId'); // Clear from local storage
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
		} else if (reason === 'agent_disconnected') {
			message = 'The agent unexpectedly disconnected. Your chat session has ended.';
		} else if (reason === 'customer_cancelled_queue') {
			message = 'Your chat request was cancelled.';
		}
		chatEndedMessage.textContent = message;
	}
});

socket.on('disconnect', () => {
	// Handle unexpected disconnects
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

// Auto-reconnect on socket.io (default behavior, but good to note)
socket.on('reconnect', () => {
	console.log('Socket reconnected. Re-emitting chat request if in queue or active.');
	// Re-emit chat request if still in queue or active session was stored.
	// This is a basic attempt. A more robust solution would involve server-side session recovery.
	const storedCustomerName = localStorage.getItem('customerName');
	const storedEmail = localStorage.getItem('customerEmail');
	const storedTopic = localStorage.getItem('topic');
	const storedSessionId = localStorage.getItem('currentSessionId');

	if (storedCustomerName && storedTopic) {
		// If a session ID was active, try to rejoin
		if (storedSessionId) {
			// Server should handle re-joining rooms and checking session status
			// For now, re-requesting chat will create a new session if old one closed,
			// or put back in queue/assigned if server side state persists.
			// This re-request path needs careful server-side handling to avoid duplicate sessions.
			// A better way is to simply assume connection loss ends the customer session from client side.
			// The current approach for customers on disconnect shows "chat ended".
		} else {
			// Re-request if customer was on index page or just starting
			// socket.emit('customer:request_chat', { customerName: storedCustomerName, customerEmail: storedEmail, topic: storedTopic });
		}
	}
});

// Initial logic when customer_chat.html loads:
// The code at the top handles checking localStorage and emitting 'customer:request_chat'
// if the necessary information is present.
