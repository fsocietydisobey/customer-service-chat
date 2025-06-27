// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User'); // Required if you need to check user role from DB

module.exports = async function (req, res, next) {
	// Get token from header
	const authHeader = req.header('Authorization');
	const token = authHeader ? authHeader.replace('Bearer ', '') : null;

	// Check if not token
	if (!token) {
		return res.status(401).json({ msg: 'No token, authorization denied' });
	}

	// Verify token
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		req.user = decoded.user; // Attach user payload (id, username, role) to request

		// Optional: Fetch user from DB to ensure they still exist and have the correct role
		const user = await User.findById(req.user.id);
		if (!user || user.role !== 'agent') { // Ensure only agents can access protected routes
			return res.status(403).json({ msg: 'Forbidden: Not an authorized agent' });
		}

		next();
	} catch (err) {
		res.status(401).json({ msg: 'Token is not valid' });
	}
};
