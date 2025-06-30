# Use an official Node.js runtime as a parent image
# Using a specific version (e.g., 18-alpine or 20-alpine) is good practice for stability
FROM node:24-alpine

# Set the working directory in the container
WORKDIR /app

# Install Node.js dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm ci is preferred for CI/CD, npm install for general dev)
COPY package*.json ./

# Install project dependencies
# Use npm ci for clean installs in production/CI environments
# For development, 'npm install' is often used.
RUN npm install

# Copy the entire application code into the container
COPY . .

# Expose the port your app runs on
# This needs to match the PORT environment variable in your .env or server.js
EXPOSE 3000

# Define environment variables.
# IMPORTANT: For production, sensitive variables like MONGO_URI and JWT_SECRET
# should NOT be hardcoded here. Pass them securely via Docker Compose environment
# variables, Kubernetes secrets, or during 'docker run' using -e flags.
# For demonstration purposes, we'll assume they are handled externally or via .env (which is not copied into the image).
# This Dockerfile focuses on building the image; environment configuration is at runtime.

# Command to run the application
CMD [ "node", "server.js" ]
