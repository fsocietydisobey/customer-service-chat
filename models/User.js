// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
	username: {
		type: String,
		required: true,
		unique: true,
	},
	password: {
		type: String,
		required: true,
	},
	role: { // Added: 'agent', 'admin', 'customer' (if customers register)
		type: String,
		enum: ['agent', 'admin'], // For this app, only agents and admins will log in
		default: 'agent',
		required: true,
	},
	isOnline: { // Added: Tracks agent's general online presence
		type: Boolean,
		default: false,
	},
	status: { // Added: Agent availability status: 'available', 'unavailable', 'chatting'
		type: String,
		enum: ['available', 'unavailable', 'chatting'], // 'chatting' implies they are in at least one chat
		default: 'unavailable', // Agents start as unavailable
	},
	createdAt: {
		type: Date,
		default: Date.now,
	},
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
	if (!this.isModified('password')) {
		return next();
	}
	const salt = await bcrypt.genSalt(10);
	this.password = await bcrypt.hash(this.password, salt);
	next();
});

// Method to compare passwords
UserSchema.methods.matchPassword = async function (enteredPassword) {
	return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
