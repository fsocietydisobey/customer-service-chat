const pino = require('pino');

// Determine log level based on environment
const logLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

// Configuration for pino-pretty in development
const transport = process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname', // Hide unnecessary fields in development
    },
} : undefined; // No transport needed for production (Pino writes JSON to stdout by default)

const logger = pino({
    level: logLevel,
    // Base properties that will be added to every log message
    base: {
        app: 'chat-app', // Replace with your application name
        // You can add other global context here if needed
    },
    transport,
});

module.exports = logger;