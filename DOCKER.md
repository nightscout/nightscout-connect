# Running nightscout-connect in Docker

## Quick Start

1. **Create your environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your credentials:**
   ```bash
   nano .env
   ```

3. **Build and run with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

4. **View logs:**
   ```bash
   docker-compose logs -f
   ```

5. **Stop the container:**
   ```bash
   docker-compose down
   ```

## Manual Docker Commands

### Build the image:
```bash
docker build -t nightscout-connect .
```

### Run the container:
```bash
docker run -d \
  --name nightscout-connect \
  --restart unless-stopped \
  --env-file .env \
  nightscout-connect
```

### View logs:
```bash
docker logs -f nightscout-connect
```

### Stop and remove:
```bash
docker stop nightscout-connect
docker rm nightscout-connect
```

## VPS Deployment

### Prerequisites
- Docker and Docker Compose installed on your VPS
- `.env` file with your credentials

### Steps

1. **SSH into your VPS:**
   ```bash
   ssh user@your-vps-ip
   ```

2. **Create a directory for the app:**
   ```bash
   mkdir -p ~/nightscout-connect
   cd ~/nightscout-connect
   ```

3. **Copy files to VPS** (from your local machine):
   ```bash
   # Option 1: Using scp
   scp -r ./* user@your-vps-ip:~/nightscout-connect/
   
   # Option 2: Using rsync
   rsync -avz --exclude 'node_modules' --exclude '.git' ./ user@your-vps-ip:~/nightscout-connect/
   
   # Option 3: Clone from git (if you push to a repo)
   git clone https://github.com/yourusername/nightscout-connect.git
   cd nightscout-connect
   ```

4. **Create and configure `.env` file on VPS:**
   ```bash
   nano .env
   ```
   Add your configuration as described above.

5. **Start the container:**
   ```bash
   docker-compose up -d
   ```

6. **Check if it's running:**
   ```bash
   docker-compose ps
   docker-compose logs
   ```

7. **Enable auto-start on reboot:**
   The `restart: unless-stopped` policy in docker-compose.yml ensures the container automatically restarts after system reboot.

## Troubleshooting

### View real-time logs:
```bash
docker-compose logs -f nightscout-connect
```

### Restart the container:
```bash
docker-compose restart
```

### Rebuild after code changes:
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Check container status:
```bash
docker-compose ps
docker stats nightscout-connect
```

## Update the Container

```bash
cd ~/nightscout-connect
git pull  # if using git
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Environment Variables

All environment variables should be prefixed with `CONNECT_`:

- `CONNECT_SOURCE` - Data source type (e.g., nightscout, dexcomshare, librelinkup, glooko)
- `CONNECT_SOURCE_ENDPOINT` - Source Nightscout URL
- `CONNECT_SOURCE_API_SECRET` - Source API secret (optional if using token)
- `CONNECT_NIGHTSCOUT_ENDPOINT` - Target Nightscout URL
- `CONNECT_API_SECRET` - Target API secret
- `CONNECT_DEBUG` - Enable debug logging (true/false)

See the main README.md for more configuration options.
