// config/db.js
const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
	try {
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		logger.info('MongoDB Connected...');
	} catch (err) {
		logger.fatal({err}, 'MongoDB connection failed');
		process.exit(1); // Exit process with failure
	}
};

module.exports = connectDB;
