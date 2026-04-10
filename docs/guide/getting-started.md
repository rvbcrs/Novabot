# Getting Started

This guide walks you through setting up OpenNova with your Novabot mower and the official Novabot app.

## Prerequisites

- OpenNova Docker container running (see [Docker Guide](docker.md))
- DNS configured so `*.lfibot.com` resolves to your local network (see [DNS Setup](dns-setup.md))
- Official Novabot app installed on your phone (iOS or Android)

## Step 1: Start the Container

Make sure your `docker-compose.yml` includes **port 443** and **ENABLE_TLS**. The official Novabot app connects via HTTPS — without this, the app will show "network connection is abnormal":

```yaml
services:
  opennova:
    image: rvbcrs/opennova:latest
    container_name: opennova
    restart: unless-stopped
    ports:
      - "80:80"       # HTTP (API + admin panel + mower connectivity check)
      - "443:443"     # HTTPS (required for Novabot app)
      - "1883:1883"   # MQTT broker
    environment:
      PORT: 80
      JWT_SECRET: change_me_to_a_random_secret
      ENABLE_TLS: "true"
    volumes:
      - novabot-data:/data

volumes:
  novabot-data:
```

Start the container:

```bash
docker compose up -d
```

Verify it's running:
```bash
docker compose logs -f
```

You should see the MQTT broker starting and TLS enabled on port 443.

## Step 2: Access the Admin Page

Open your browser and go to:

```
http://<server-ip>/admin
```

### First-time setup

On first visit (empty database), the admin panel shows a **setup wizard**:

1. Enter your **Novabot app email** and **password**
2. Click **Connect & Import from Cloud**
3. The server creates your account, imports your devices and maps from the cloud, and auto-pairs any devices already online

After import, you're automatically logged into the admin panel.

### Verify DNS

Go to the **Settings** tab. The **Network & DNS** section automatically checks if `mqtt.lfibot.com` and `app.lfibot.com` resolve to local IPs.

- Green checkmark = domain resolves to a local IP (correctly redirected)
- Red X = domain still points to the Novabot cloud (DNS not configured)

If DNS is not configured, either:
- Use the built-in **dnsmasq** (click Start) and point your router's DNS to the container IP
- Or configure DNS rewrites in AdGuard Home / Pi-hole

## Step 3: Import Your Devices (if you skipped the wizard)

If you skipped the setup wizard, you can import from the admin **Settings** tab > **Cloud Import**:

1. Enter your Novabot app email and password
2. Click **Connect & Import**
3. Your mower and charger will be imported with their serial numbers and credentials

## Step 4: Connect the Novabot App

### Install the SSL certificate (iOS required, Android optional)

The official Novabot app connects to `app.lfibot.com` via HTTPS. Since your DNS now redirects this to your local server, the app needs to trust your server's SSL certificate. Without it, iOS will refuse to connect.

You can download the certificate from the admin panel: **Settings > Certificate Setup**.

#### iOS

1. Open `http://<server-ip>/admin` **on your iPhone/iPad**
2. Go to **Settings > Certificate Setup** and tap **Download iOS Profile**
3. Go to **Settings > General > VPN & Device Management**
4. Tap the **OpenNova** profile and tap **Install**
5. Go to **Settings > General > About > Certificate Trust Settings**
6. Enable **OpenNova CA Certificate**

#### Android

1. Download the certificate from the admin panel (Settings > Certificate Setup)
2. Go to **Settings > Security > Install certificate > CA certificate**
3. Select the downloaded file and confirm

!!! note "Why is this needed?"
    Your OpenNova server generates a self-signed certificate for `app.lfibot.com`. The Novabot app uses HTTPS to communicate with the server. Without the certificate installed, iOS blocks the connection entirely and Android may show SSL errors.

### Log out and log back in

!!! warning "Important"
    The Novabot app caches an authentication token from the Novabot cloud. This token is **not valid** on your local OpenNova server. You **must** log out of the app and log back in so the app receives a new token from your local server.

1. **Open** the Novabot app
2. Go to **Settings** (or Profile)
3. **Log out** of your current account
4. **Log back in** with the same email and password
5. The app now connects to your local OpenNova server instead of the cloud

### Verify connection

After logging in, you should see:
- Your mower and charger in the app's device list
- Live battery status, GPS satellites, WiFi signal
- The map (if you've created one)

In the admin **Console** tab, you should see MQTT traffic from the app (blue) and devices (green/yellow).

## Step 5: Create a Map

Using the **official Novabot app**:

1. Go to the **Lawn** tab
2. Tap **Create Map**
3. Drive the mower around the perimeter of your lawn using the joystick
4. Close the boundary and save the map
5. Position the charger and save the charging position

The map will be synced to your OpenNova server automatically.

## Step 6: Start Mowing

From the official Novabot app or the OpenNova app:

1. Select the work area
2. Set the cutting height (2-9 cm)
3. Tap **Start Mowing**

The mower will navigate from the charger to the work area and begin coverage mowing.

## Troubleshooting

### App shows "Login failed" or "Network error"
- Verify DNS is correctly configured (admin Settings > Network & DNS)
- Make sure you logged out and back in (see Step 4)

### Mower doesn't appear in the app
- Check that the mower is connected to WiFi
- Verify MQTT traffic in the admin Console tab
- The mower needs `mqtt.lfibot.com` to resolve to your server

### Map doesn't show in the app
- The map polygon is served via HTTP from the `queryEquipmentMap` endpoint
- Check the admin Console for HTTP requests to `/api/nova-file-server/map/`

### Mower won't start mowing
- Ensure the mower has a valid map with a unicom (channel) path
- Check `localization_state` in the mower's status — it must be `RUNNING`
- If `error_status` is non-zero, the mower may need to be reset

### iOS app can't connect
- Make sure you installed the SSL certificate (see Step 4)
- iOS requires HTTPS with a trusted certificate — without it the app silently fails
- Verify the certificate is trusted: Settings > General > About > Certificate Trust Settings
