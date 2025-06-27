// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// @route   POST api/auth/register
// @desc    Register a new agent (or admin)
// @access  Public (should be protected in production, e.g., only by an existing admin)
router.post('/register', async (req, res) => {
	const { username, password, role } = req.body;

	try {
		let user = await User.findOne({ username });
		if (user) {
			return res.status(400).json({ msg: 'User already exists' });
		}

		// Validate role to prevent arbitrary role creation
		if (!['agent', 'admin'].includes(role)) {
			return res.status(400).json({ msg: 'Invalid role specified' });
		}

		user = new User({
			username,
			password,
			role,
		});

		await user.save();

		res.status(201).json({ msg: `${role} registered successfully` });
	} catch (err) {
		console.error(err.message);
		res.status(500).send('Server Error');
	}
});

// @route   POST api/auth/login
// @desc    Authenticate user (agent/admin) & get token
// @access  Public
router.post('/login', async (req, res) => {
	const { username, password } = req.body;

	try {
		let user = await User.findOne({ username });
		if (!user) {
			return res.status(400).json({ msg: 'Invalid Credentials' });
		}

		const isMatch = await user.matchPassword(password);
		if (!isMatch) {
			return res.status(400).json({ msg: 'Invalid Credentials' });
		}

		// Only allow agents/admins to log in via this route
		if (!['agent', 'admin'].includes(user.role)) {
			return res.status(403).json({ msg: 'Access Denied: Not an agent or admin' });
		}

		const payload = {
			user: {
				id: user.id,
				username: user.username,
				role: user.role, // Include role in JWT payload
			},
		};

		jwt.sign(
			payload,
			process.env.JWT_SECRET,
			{ expiresIn: '8h' }, // Token valid for 8 hours
			(err, token) => {
				if (err) throw err;
				res.json({ token, userId: user.id, username: user.username, role: user.role });
			}
		);
	} catch (err) {
		console.error(err.message);
		res.status(500).send('Server Error');
	}
});

module.exports = router;
