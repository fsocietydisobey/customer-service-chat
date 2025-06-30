# customer-service-chat

This document outlines how to run your customer service chat application using Docker Compose for local development and
debugging, and provides a comprehensive guide for deployment to an Ubuntu server with Nginx and SSL.

### Running with Docker Compose and Accessing Container Terminals

To run your customer service chat application using Docker Compose and access the terminals for debugging and
monitoring, follow these steps:

#### Step 1: Run your Docker Compose services in detached mode

First, navigate to your `customer-service-chat` project directory in your terminal (where your Dockerfile and
`docker-compose.yml` files are located). Then, execute the following command to start your services in the background:

```
docker compose up -d --build
```

- `up`: This command builds (if necessary) and starts the services defined in your `docker-compose.yml` file.
- `-d` (or `--detach`): This flag runs the containers in the background, freeing up your current terminal.
- `--build`: This flag ensures that the `app` service's Docker image is rebuilt from its `Dockerfile` if there have been
  any
  changes to your application code or `Dockerfile`.

#### Step 2: Accessing Logs for the Node.js Application

Once your `app` service is running, you can stream its logs to see your `console.log` output in real-time. This is
essential
for monitoring and debugging your Node.js application. Open a new terminal window (keep the first one running `docker
compose up -d` open, or at least running in the background) and execute:

```
docker compose logs -f app
```

- `logs`: Displays log output from services.
- `-f` (or `--follow`): Streams new log entries as they happen, so you'll see your console.log messages as the Node.js
  app runs.
- `app`: This is the name of your Node.js application service as defined in docker-compose.yml.

#### Step 3: Accessing the MongoDB Container Terminal

To get an interactive shell inside your `mongodb` container, you'll use the `exec` command. This allows you to run
commands
directly within a running container, like connecting to the Mongo shell to interact with your database.

Open another new terminal window (separate from the previous one) and run:

```
docker compose exec mongodb sh
```

- `exec`: Executes a command in a running container.
- `mongodb`: This is the name of your MongoDB service as defined in `docker-compose.yml`.
- `sh`: This is the shell (like `bash` or `sh`) that will be opened inside the container. Since `mongo:latest` often
  uses Alpine Linux, `sh` is commonly available.

Once you are inside the MongoDB container's terminal (you'll see a prompt like / #), you can start the Mongo Shell to
interact with your database:

mongosh

(Note: If `mongosh` isn't found, try `mongo` if it's an older MongoDB image, or check the MongoDB Docker image
documentation
for the correct shell command.)

You should then see the Mongo Shell prompt (e.g., `test>`  or `mydb>` ), and you can run MongoDB commands like
`show dbs;` or
`use customer_service_chat; show collections;`.

### Deployment to Ubuntu Server with Nginx and SSL (Recommended Approach)

For deploying your customer chat application (Node.js + MongoDB) to an Ubuntu server, the containerized approach using
Docker (and Docker Compose) with Nginx as a reverse proxy and Certbot for SSL is the recommended and most robust method.

#### 1. Traditional Setup (Manual Configuration) - Not Recommended for this App

#### How it works:

You would SSH into your Ubuntu server, manually install Node.js, npm, MongoDB, configure MongoDB (e.g., users, data
paths), install Nginx, configure Nginx to proxy requests to your Node.js app, and then use a process manager like PM2 to
keep your Node.js app running reliably.

#### Pros:

- Simpler for very small, single-app deployments if you're highly familiar with Linux administration.
- Direct control over all components.
- Potentially slightly lower resource overhead.

#### Cons:

- Environment inconsistencies: High risk of "works on my machine, but not on server" issues.
- Complex dependency management: Manual installation and updates of Node.js, npm, MongoDB, etc., can lead to conflicts.
- Scalability challenges: Harder to manage multiple app instances.
- Difficult updates & rollbacks: Prone to breaking changes and complex to revert.
- Lack of isolation: Dependencies installed directly on the host OS can conflict.
- Requires separate process manager (e.g., PM2) for app uptime.

#### 2. Containerized Setup (Docker with Nginx Reverse Proxy) - Recommended

#### How it works:

You install Docker and Docker Compose on your Ubuntu server. Your Node.js app and MongoDB run inside Docker containers.
Nginx runs directly on the host as a reverse proxy, forwarding web traffic (HTTP/HTTPS) to your Dockerized Node.js
application. Certbot is used on the host to automate SSL certificate management for Nginx.

#### Pros:

- Consistency (Dev/Prod Parity): The Docker image is identical across environments.
- Isolation: Containers provide isolated environments, preventing conflicts.
- Simplified Dependency Management: Dependencies are bundled within images; no host-level conflicts.
- Easier Scaling: Docker Compose simplifies running multiple app instances.
- Simplified Updates & Rollbacks: Deploying new versions or reverting is fast and reliable.
- Portability: Easily move your setup to other servers or cloud providers.
- Nginx Integration: Nginx efficiently handles static files, load balancing, and SSL termination.
- Automated SSL: Certbot automates obtaining and renewing Let's Encrypt SSL certificates.

#### Cons:

- Initial Learning Curve: If new to Docker/Nginx/Certbot, there's a learning curve.
- Resource Usage: Docker daemon consumes some resources (minimal for this app).

### Step-by-Step Deployment Guide (Docker, Nginx, Certbot on Ubuntu)

This guide assumes you have a fresh Ubuntu Server (20.04 LTS or newer) and a domain name pointing to your server's
public IP address.

**A. Server Preparation**

1. Update System Packages:
    ```
    sudo apt update && sudo apt upgrade -y
    ```
2. Install Docker & Docker Compose:
    ```
    sudo apt update
    sudo apt install docker.io docker-compose
    sudo systemctl start docker
    sudo systemctl enable docker
    ```

3. Install Docker Compose:
    ```
    sudo apt install docker-compose -y
    ```
   __(Note: If `docker-compose` is not found or you need a newer version, you might need to install it as a
   plugin: `sudo apt install docker-compose-plugin` and use `docker compose` without the hyphen.)__


4. Add Your User to the Docker Group (Optional, but convenient):

   This allows you to run `docker` commands without `sudo`.
    ```
    sudo usermod -aG docker $USER
    newgrp docker # Apply group changes immediately without logging out/in
    ```

5. Install Nginx:
    ```
    sudo apt install nginx -y
    sudo systemctl start nginx
    sudo systemctl enable nginx
    ```


6. Configure Firewall (UFW):
    ```
    sudo ufw allow OpenSSH # Ensure SSH access is allowed
    sudo ufw allow 'Nginx HTTP' # Allow HTTP (port 80)
    sudo ufw allow 'Nginx HTTPS' # Allow HTTPS (port 443)
    sudo ufw enable # Enable the firewall
    sudo ufw status # Verify rules
    ```

**B. Deploying Your Application**

1. Transfer Your Project Files:

   Use `scp` or `git clone` to get your `customer-service-chat` project folder onto your Ubuntu server.

    - Using scp (if files are local):

       ```
       scp -r /path/to/your/local/customer-service-chat user@your_server_ip:/home/user/
       ```

    - Using git clone (recommended if using Git):
        ```
        git clone https://github.com/your_username/your_repo.git customer-service-chat
        cd customer-service-chat
        ```

2. Navigate to Project Directory on Server:
    ```
    cd /home/user/customer-service-chat # Or wherever you put it
    ```

3. Create/Configure `.env` file for Production:
   Ensure your `.env` file in the project root is configured for production.
   ``
    - `MONGO_URI`: This should remain `mongodb://mongodb:27017/customer_service_chat` as `mongodb` is the service name
      within Docker Compose's internal network.
    - `JWT_SECRET`: Crucially, use a very strong, long, and random secret here.
    - `PORT`: `3000` (as your Node.js app listens on this internally).

      Example `.env` on server:
       ```
        MONGO_URI=mongodb://mongodb:27017/customer_service_chat
        JWT_SECRET=YOUR_VERY_LONG_AND_RANDOM_PRODUCTION_JWT_SECRET_HERE
        PORT=3000
       ```

4. Run Docker Compose in Production Mode:
    ```
    docker compose up -d --build
    ```
   This will:

    - Build your app image (if changes detected).
    - Pull the mongo:latest image.
    - Start both containers.
    - Map container port 3000 (Node.js app) to host port 3000 (as per docker-compose.yml).
    - Map container port 27017 (MongoDB) to host port 27017.
    - Persist MongoDB data in the mongodb_data Docker volume.

   **Important Security Note**: For production, you might want to modify your `docker-compose.yml` to not expose
   MongoDB's port (`27017`) to the host, as it's generally not needed externally and reduces attack surface. Only the
   `app` service needs to connect to it.

   ```
   # In docker-compose.yml for production:
   services:
      mongodb:
        # ...
        # Remove or comment out this line to prevent external access to MongoDB
        # ports:
        #   - "27017:27017"
        # ...
   ```

   If you do this, remember to run `docker compose down` and then `docker compose up -d --build` again.

**C. Configure Nginx as a Reverse Proxy**

Nginx will listen on standard HTTP/HTTPS ports and forward requests to your Dockerized Node.js application.

1. Create Nginx Configuration File:
   ```
   sudo nano /etc/nginx/sites-available/chat_app
   ```
    
   Paste the following configuration. Replace `your_domain.com` with your actual domain name.
   ```
    server {
        listen 80;
        server_name your_domain.com www.your_domain.com; # Replace with your domain(s)

        # Redirect HTTP to HTTPS (important for Certbot)
        location / {
            return 301 https://$host$request_uri;
        }
    }

    server {
        listen 443 ssl;
        server_name your_domain.com www.your_domain.com; # Replace with your domain(s)

        # SSL certificates will be added by Certbot later
        # ssl_certificate /etc/letsencrypt/live/your_domain.com/fullchain.pem;
        # ssl_certificate_key /etc/letsencrypt/live/your_domain.com/privkey.pem;

        # Recommended SSL settings (from Certbot documentation)
        include /etc/letsencrypt/options-ssl-nginx.conf;
        ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

        location / {
            # Proxy requests to your Node.js app running on host port 3000
            proxy_pass http://localhost:3000; # This maps to the host port you exposed in docker-compose.yml
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Adjust proxy timeouts if your app has long-running connections (e.g., websockets)
            proxy_read_timeout 86400s; # For long-lived WebSocket connections
            proxy_send_timeout 86400s;
        }

        # Optional: Proxy WebSocket connections for Socket.IO
        # This is already covered by the proxy_set_header Upgrade/Connection, but explicit might be clearer
        # location /socket.io/ {
        #     proxy_pass http://localhost:3000/socket.io/;
        #     proxy_http_version 1.1;
        #     proxy_set_header Upgrade $http_upgrade;
        #     proxy_set_header Connection "upgrade";
        #     proxy_set_header Host $host;
        #     proxy_read_timeout 86400s;
        #     proxy_send_timeout 86400s;
        # }
    }
   ```

    Save and close the file (Ctrl+X, Y, Enter).

2. Enable the Nginx Configuration:

    Create a symbolic link from `sites-available` to `sites-enabled`.

    ```
    sudo ln -s /etc/nginx/sites-available/chat_app /etc/nginx/sites-enabled/
    ```
3. Remove Default Nginx Configuration:
    ```
    sudo rm /etc/nginx/sites-enabled/default
    ```
4. Test Nginx Configuration and Restart:
    ```
    sudo nginx -t # Test for syntax errors
    sudo systemctl restart nginx
    ```
**D. Secure with SSL (Certbot)**

This step automates obtaining and renewing free SSL certificates from Let's Encrypt.

1. Install Certbot and Nginx Plugin:
    ```
    sudo snap install core
    sudo snap refresh core
    sudo snap install --classic certbot
    sudo ln -s /snap/bin/certbot /usr/bin/certbot
    sudo snap set certbot trust-plugin-with-sudo=ok # Required for some setups
    ```
2. Obtain SSL Certificate:
    ```
    sudo certbot --nginx -d your_domain.com -d www.your_domain.com
    ```
   - Follow the prompts. Certbot will automatically detect your Nginx configuration, obtain certificates, and configure Nginx to use them.
   - It will also set up automatic renewals.

3. Verify Auto-Renewal (Optional):
    ```
    sudo certbot renew --dry-run
    ```
**E. Managing Your Application on the Server**

- Start/Stop/Restart:
    ```
    cd /path/to/your/customer-service-chat
    docker compose up -d # Start (if stopped)
    docker compose down # Stop and remove containers
    docker compose restart app # Restart just the Node.js app
    ```
- View Logs:
    ```
    cd /path/to/your/customer-service-chat
    docker compose logs -f app # Follow Node.js app logs
    docker compose logs -f mongodb # Follow MongoDB logs
    ```
- Update Application Code:

  1. Transfer new code to the server.
  2. Navigate to your project directory.
  3. 
     ```
     docker compose pull # Pull any updated base images (e.g., node:24-alpine)
     docker compose up -d --build --force-recreate app # Rebuild and recreate only the app service
     ```
This comprehensive guide should provide you with all the necessary steps to deploy and manage your customer service chat
application on an Ubuntu server using Docker, Nginx, and SSL.