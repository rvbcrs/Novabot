# OpenNova Tester Guide

Complete guide to set up a working OpenNova server and connect your Novabot mower + charging station.

---

## What is OpenNova?

OpenNova is a **local replacement** for the Novabot cloud. Instead of your mower and charger talking to `app.lfibot.com`, they talk to a server on your own network. This gives you:

- Full control over your devices
- No dependency on the Novabot cloud
- Keep using the **original Novabot app** for daily operation

---

## What you need

| Item | Description |
|------|-------------|
| **Docker host** | Mac, Linux PC, NAS (Synology/QNAP), or Raspberry Pi 4/5 |
| **Novabot mower** | LFIN series (e.g. LFIN2230700238) |
| **Novabot charger** | LFIC series (e.g. LFIC1230700004) |
| **WiFi network** | 2.4 GHz (mower/charger do not support 5 GHz) |
| **Phone** | iPhone or Android with the Novabot app installed |

---

## Step 1: Install the server with Docker

### 1.1 Install Docker

If you don't have Docker yet:
- **Mac**: Download [Docker Desktop](https://docker.com/products/docker-desktop)
- **Linux**: `sudo apt install docker.io docker-compose-plugin`
- **Synology NAS**: Container Manager (built-in)
- **Raspberry Pi**: `curl -fsSL https://get.docker.com | sh`

### 1.2 Start OpenNova

Create a directory and configuration file:

```bash
mkdir opennova && cd opennova

cat > docker-compose.yml << 'EOF'
services:
  opennova:
    image: rvbcrs/opennova:latest
    container_name: opennova
    restart: unless-stopped
    ports:
      - "80:80"        # HTTP (API + admin panel + mower connectivity check)
      - "443:443"      # HTTPS (required for Novabot app on iOS)
      - "1883:1883"    # MQTT broker
    environment:
      PORT: 80
      JWT_SECRET: change-this-to-something-random
      ENABLE_TLS: "true"
      DB_PATH: /data/novabot.db
      STORAGE_PATH: /data/storage
      FIRMWARE_PATH: /data/firmware
    volumes:
      - novabot-data:/data

volumes:
  novabot-data:
EOF

docker compose up -d
```

### 1.3 Verify the server is running

```bash
curl http://<server-ip>/api/setup/health
```

You should get a JSON response. Note your **server IP** (e.g. `192.168.0.100`) — you'll need it for DNS setup.

> **Tip**: Use `hostname -I` (Linux) or `ipconfig getifaddr en0` (Mac) to find your IP.

---

## Step 2: Configure DNS

Your mower and charger need to find your server instead of the Novabot cloud. See the [DNS Setup Guide](guide/dns-setup.md) for detailed instructions.

The quick version: make `mqtt.lfibot.com` and `app.lfibot.com` point to your server IP. You can do this via:

- Your router's DNS settings (easiest for Fritz!Box, ASUS)
- Pi-hole or AdGuard Home
- OpenNova's built-in DNS server (add `ENABLE_DNS: "true"` and port `53:53/udp` to docker-compose)

---

## Step 3: Open the Admin Panel

Open your browser and go to:

```
http://<server-ip>/admin
```

### First-time setup wizard

On first visit, the admin panel shows a **Welcome to OpenNova** setup wizard:

1. Enter your **Novabot app email** and **password**
2. Click **Connect & Import from Cloud**
3. The server will:
    - Create your local admin account
    - Import your devices (charger + mower) from the Novabot cloud
    - Download your maps from the cloud
    - Auto-pair devices that are already online via MQTT

After import, you're automatically logged in to the admin panel.

> **Skip cloud import?** Click "Skip" to create a local-only account (admin@local / admin). You can import from cloud later via Settings > Cloud Import.

---

## Step 4: Connect the Novabot app

### Install the SSL certificate (required for iOS)

The Novabot app connects via HTTPS. Since DNS now redirects `app.lfibot.com` to your server, the app needs to trust your server's certificate.

1. Open `http://<server-ip>/admin` **on your phone**
2. Go to **Settings > Certificate Setup**
3. Tap **Download iOS Profile** (or download the certificate for Android)

**iOS:**

1. Go to **Settings > General > VPN & Device Management**
2. Tap the **OpenNova** profile > **Install**
3. Go to **Settings > General > About > Certificate Trust Settings**
4. Enable **OpenNova CA Certificate**

**Android:**

1. Go to **Settings > Security > Install certificate > CA certificate**
2. Select the downloaded file and confirm

### Log out and log back in

!!! warning "Important"
    The Novabot app caches an authentication token from the Novabot cloud. You **must** log out and log back in so the app gets a new token from your local server.

1. Open the Novabot app
2. Go to **Settings** (or Profile)
3. **Log out**
4. **Log back in** with the same email and password

You should now see your mower and charger in the app.

---

## Step 5: Daily use

After setup, use the **original Novabot app** for daily operation. It works identically — the only difference is that communication goes through your local server.

The Novabot app offers:
- Real-time mower status (battery, position, activity)
- Start/stop/pause mowing
- View and edit maps
- Set mowing schedules
- Manual control (joystick)
- Mowing history

The **OpenNova admin panel** (`http://<server-ip>/admin`) offers:
- Device overview with online status
- Server console (MQTT traffic)
- Cloud import / export
- DNS & certificate management
- Factory reset

---

## FAQ

### My charger/mower doesn't appear after setup

1. **WiFi**: Is your network 2.4 GHz? 5 GHz doesn't work.
2. **DNS**: Does `mqtt.lfibot.com` resolve to your server IP? Check via admin panel Settings > Network & DNS.
3. **MQTT reachable**: Can the device reach port 1883?
   ```bash
   nc -zv <server-ip> 1883
   ```
4. **Restart**: Power off the device, wait 10 seconds, power on. It reconnects automatically.
5. **Logs**: Check the server logs:
   ```bash
   docker logs opennova -f --tail 100
   ```

### App shows "Login failed" or devices don't appear

- Make sure you **logged out and back in** (see Step 4)
- Verify the SSL certificate is installed (iOS)
- Check DNS is working (admin Settings > Network & DNS)

### Mower shows "error 151"

This is a localization error. The mower needs to drive a short distance to determine its heading via GPS. This resolves itself once the mower has moved.

### Can I go back to the Novabot cloud?

Yes. Remove the DNS redirect and the devices will connect to the cloud again on next restart. Or re-provision via the original Novabot app.

### Does the app work over mobile data (4G/5G)?

Only if your server is reachable from outside (via VPN or port forwarding). By default it only works on your local WiFi network.

### How to update

```bash
docker compose pull
docker compose down && docker compose up -d
```

Your database and settings are preserved (volume `novabot-data`).

---

## Troubleshooting

### View server logs
```bash
docker logs opennova -f --tail 100
```

### Factory reset (via admin panel)
Go to admin panel > Settings > Danger Zone > Factory Reset. This deletes all data and returns to the setup wizard.

### Factory reset (via Docker)
```bash
docker compose down
docker volume rm opennova_novabot-data
docker compose up -d
```

### Check ports
```bash
curl http://<server-ip>/api/setup/health   # HTTP API
nc -zv <server-ip> 1883                     # MQTT broker
nc -zv <server-ip> 443                      # HTTPS (Novabot app)
```

---

## Technical details

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | HTTP | API server + admin panel |
| 443 | HTTPS | Novabot app (iOS requires TLS) |
| 1883 | MQTT | Device communication |
| 53 | DNS (optional) | Built-in DNS server |

### How it works

```
Novabot App (phone)
    ↕ HTTPS (port 443)
OpenNova Server (Docker)
    ↕ MQTT (port 1883)
Charger + Mower (WiFi)
```

The server runs an MQTT broker for device communication and an HTTP/HTTPS API for the Novabot app. All device communication is AES-128-CBC encrypted.
