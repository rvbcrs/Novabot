# Beginner Installation Guide

This guide is for people who have never installed a Raspberry Pi, Docker, or a
self-hosted server before. Follow it from top to bottom and you should end with:

- A Raspberry Pi running OpenNova all the time.
- The OpenNova admin page reachable from your browser.
- Your mower and charger imported into OpenNova.
- A clear next step for connecting the OpenNova app or the original Novabot app.

You do not need to clone the GitHub repository. The Docker image already contains
the server, admin page, MQTT broker, and storage logic.

## Short Answer: Raspberry Pi 4 Is Enough

Yes. A Raspberry Pi 4 is the normal recommendation for OpenNova.

OpenNova mostly stores data, serves the app, and routes MQTT messages between
the mower, charger, and phone. The mower does the heavy robotics work itself.
For a typical home installation, a Raspberry Pi 4 with 4 GB RAM is more than
enough. The Raspberry Pi 4 also has Gigabit Ethernet, which is useful for a
stable always-on server.

Choose a Raspberry Pi 5 only if the price difference is small, you already own
one, or you plan to run several other containers on the same device.

## What To Buy

Recommended shopping list:

| Item | Recommendation | Why |
|------|----------------|-----|
| Raspberry Pi | Raspberry Pi 4 Model B, 4 GB | Cheap, quiet, enough performance |
| Power supply | Official Raspberry Pi 4 USB-C 3A power supply | Prevents random crashes and SD-card corruption |
| Storage | 64 GB or 128 GB high-endurance microSD card | Enough space for database, maps, logs, and updates |
| Case | Any ventilated Raspberry Pi 4 case | Protects the board |
| Network cable | Ethernet cable | More reliable than Wi-Fi for a server |
| Computer | Windows, macOS, or Linux computer with SD-card reader | Used once to prepare the SD card |

Nice upgrades:

| Upgrade | When it helps |
|---------|---------------|
| USB SSD instead of microSD | Better long-term reliability |
| Raspberry Pi 5, 4 GB or 8 GB | Useful if you will run more services than OpenNova |
| Small UPS | Keeps OpenNova online during short power dips |

Avoid:

- Raspberry Pi Zero or Zero 2 W. They are too small for a comfortable server.
- Very cheap phone chargers. A weak power supply causes confusing crashes.
- Wi-Fi if Ethernet is possible. Wi-Fi works, but Ethernet is calmer.

## What You Will Need To Know

Before starting, keep these names straight:

| Word | Meaning |
|------|---------|
| Raspberry Pi | A small computer that stays on in your house |
| Raspberry Pi OS | The Linux operating system installed on the Pi |
| SSH | A way to type commands on the Pi from your normal computer |
| Docker | The tool that runs OpenNova as a container |
| Container | A packaged app with everything it needs inside |
| Router | The box that gives your home devices Wi-Fi and IP addresses |
| IP address | A number like `192.168.1.50` that points to one device on your network |

In the examples below, replace `192.168.1.50` with the real IP address of your
Raspberry Pi.

## Step 1: Prepare Raspberry Pi OS

Install Raspberry Pi Imager on your normal computer:

[Raspberry Pi Imager](https://www.raspberrypi.com/software/)

Insert the microSD card into your computer, open Raspberry Pi Imager, and choose:

| Imager setting | Choose |
|----------------|--------|
| Raspberry Pi device | Raspberry Pi 4 |
| Operating system | Raspberry Pi OS Lite, 64-bit |
| Storage | Your microSD card |

When Imager asks whether you want to customise the OS, choose **Edit Settings**.
Set:

| Setting | Example |
|---------|---------|
| Hostname | `opennova` |
| Username | `opennova` |
| Password | Choose a strong password and save it |
| Locale/timezone | Your country and timezone |
| Wireless LAN | Only fill this in if you cannot use Ethernet |
| SSH | Enable SSH, password authentication is fine for beginners |

Write the SD card. When it finishes, eject the card from your computer.

## Step 2: First Boot

1. Insert the microSD card into the Raspberry Pi.
2. Connect the Pi to your router with Ethernet.
3. Connect the official power supply.
4. Wait 3 to 5 minutes for the first boot.

The Pi has no screen in this guide. That is normal. You will connect to it from
your normal computer.

## Step 3: Find The Raspberry Pi IP Address

Try this first from your normal computer:

```bash
ping opennova.local
```

If that works, you should see an IP address. It might look like:

```text
PING opennova.local (192.168.1.50)
```

If `opennova.local` does not resolve, open your router's admin page and look for
a connected device named `opennova` or `raspberrypi`.

When you find the IP address, reserve it in your router if possible. Routers call
this setting one of these names:

- DHCP reservation
- Static lease
- Fixed IP
- Always use this IP

OpenNova works best when the Pi keeps the same IP address forever.

## Step 4: Connect With SSH

Open Terminal on macOS/Linux or Windows Terminal on Windows.

Connect using the hostname:

```bash
ssh opennova@opennova.local
```

Or connect using the IP address:

```bash
ssh opennova@192.168.1.50
```

The first time, SSH may ask if you trust the device. Type:

```text
yes
```

Then enter the password you chose in Raspberry Pi Imager.

## Step 5: Update The Raspberry Pi

Run:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Wait one minute, then connect again:

```bash
ssh opennova@opennova.local
```

## Step 6: Install Docker

This guide assumes Raspberry Pi OS Lite 64-bit. That is Debian-based, so we use
Docker's Debian installation method.

Run the full block:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
sudo systemctl enable docker
sudo reboot
```

After the reboot, reconnect:

```bash
ssh opennova@opennova.local
```

Verify Docker:

```bash
docker run hello-world
docker compose version
```

If `docker run hello-world` says `permission denied`, reboot once more. The Pi
has not refreshed your Docker group membership yet.

!!! note "Using 32-bit Raspberry Pi OS?"
    Use Raspberry Pi OS Lite 64-bit unless you have a specific reason not to.
    If you intentionally installed 32-bit Raspberry Pi OS, follow Docker's
    Raspberry Pi OS 32-bit instructions instead of the Debian commands above.

## Step 7: Create The OpenNova Folder

Create one folder that will hold the configuration and data:

```bash
mkdir -p ~/opennova
cd ~/opennova
```

## Step 8: Create docker-compose.yml

This is the same compose file as on [Installing OpenNova](docker.md); it is
kept in one place so the two never drift apart. Create it:

```bash
nano docker-compose.yml
```

Paste this, and change the `TARGET_IP` line to your Raspberry Pi's IP address:

```yaml
--8<-- "docker-compose.yml"
```

Save in nano:

1. Press `Ctrl+O`
2. Press `Enter`
3. Press `Ctrl+X`

!!! note "What is opennova-mdns?"
    A second, tiny container that lets a mower on custom firmware find the Pi
    by name. It needs no settings. You can ignore it; it takes care of itself.

## Step 9: Start OpenNova

From the `~/opennova` folder:

```bash
docker compose pull
docker compose up -d
```

Check that it is running:

```bash
docker compose ps
```

Check the health endpoint:

```bash
curl http://localhost/api/setup/health
```

Expected result:

```json
{"server":"ok","mqtt":"ok","version":"..."}
```

If you want to watch the logs:

```bash
docker compose logs -f --tail 80
```

Press `Ctrl+C` to leave the log view. That does not stop OpenNova.

## Step 10: Open The Admin Page

Open this address on your computer:

```text
http://192.168.1.50/admin
```

Replace `192.168.1.50` with your Raspberry Pi IP.

On a new installation, the admin page shows the first-time setup wizard.

Recommended first setup:

1. Enter your Novabot/LFI account email and password.
2. Click **Connect & Import from Cloud**.
3. Wait for OpenNova to import your account, mower, charger, and maps.
4. Confirm that you can see the admin tabs after login.

If the cloud import is unavailable, create a local account and import later from
**Settings -> Cloud Import**.

## Step 11: Connect Your Mower And Charger

There are two supported paths. Choose one.

### Recommended: OpenNova App

Use the OpenNova mobile app when possible. It connects directly to your OpenNova
server and uses the normal app provisioning flow to tell the mower and charger
where your server lives.

High-level flow:

1. Install the OpenNova app.
2. Set the server address to your Pi, for example `http://192.168.1.50`.
3. Log in with the account you created or imported in the admin page.
4. Use the app pairing/provisioning flow for the mower and charger.
5. Return to the admin page and open **Devices**.

Expected result:

- Mower row becomes online.
- Charger row becomes online.
- The **Console** tab shows MQTT traffic from the devices.

Read more: [OpenNova App](../user-guide/opennova-app.md)

### Alternative: Original Novabot App

Use this if you want to keep the original Novabot app.

The original app and stock firmware look for `app.lfibot.com` and
`mqtt.lfibot.com`. In that setup, configure DNS so those names resolve to your
OpenNova Pi. DNS redirect is a normal supported setup for the stock app path.

You will also need the OpenNova certificate on iOS because the original iOS app
uses HTTPS.

Read:

- [DNS Setup](dns-setup.md)
- [First-time setup with the original app](getting-started.md)

## Step 12: Verify Success

In the admin page:

| Page | What you should see |
|------|---------------------|
| Devices | Mower and charger listed |
| Devices | Online dots when they are connected |
| Console | MQTT connect and publish messages |
| Maps | Imported or newly created maps |
| Settings | Network and certificate tools |

From SSH, these commands are useful:

```bash
cd ~/opennova
docker compose ps
curl http://localhost/api/setup/health
docker compose logs --tail 100
```

## Updating OpenNova

Run:

```bash
cd ~/opennova
docker compose pull
docker compose up -d
```

OpenNova will keep using the same `./data` folder.

## Backing Up OpenNova

Your important data is in:

```text
~/opennova/data
```

Create a simple backup archive:

```bash
cd ~/opennova
tar -czf opennova-data-backup-$(date +%Y%m%d).tgz data
```

Keep that `.tgz` file somewhere safe. It contains the database, maps, uploaded
files, firmware files, and generated certificates.

## Troubleshooting

### I cannot SSH into the Raspberry Pi

Try the IP address instead of `opennova.local`:

```bash
ssh opennova@192.168.1.50
```

If that fails, check your router's connected devices list and confirm the Pi is
powered and connected by Ethernet.

### Docker says permission denied

Run:

```bash
sudo reboot
```

Then SSH back in and try again. Your user was added to the Docker group, but the
login session needs to refresh.

### The admin page does not open

Check the container:

```bash
cd ~/opennova
docker compose ps
docker compose logs --tail 100
```

Check whether something else is already using port 80:

```bash
sudo ss -ltnp | grep ':80 '
```

If another service is using port 80, remove or reconfigure that service before
starting OpenNova.

### The health check is not ok

Run:

```bash
cd ~/opennova
docker compose logs --tail 200
```

Look for startup errors such as a missing `TARGET_IP`, a port conflict, or a
database path problem.

### The mower or charger stays offline

Check the chosen connection path:

- OpenNova app path: confirm the app points to `http://192.168.1.50` and repeat
  the app pairing/provisioning flow.
- Original Novabot app path: confirm `app.lfibot.com` and `mqtt.lfibot.com`
  resolve to the Raspberry Pi IP on your network.

Then open the admin **Console** tab and look for MQTT connect messages from the
mower or charger.

### The original iOS app shows a network error

Install and trust the OpenNova certificate from the admin page:

```text
Settings -> Certificate Setup
```

Then log out of the Novabot app and log back in so it receives a fresh local
OpenNova token.

### The Raspberry Pi IP changed

Change the `TARGET_IP` line in `docker-compose.yml` and restart:

```bash
cd ~/opennova
nano docker-compose.yml
docker compose up -d
```

Also add a DHCP reservation in your router so the IP does not change again.

## Official References

- [Raspberry Pi getting started guide](https://www.raspberrypi.com/documentation/computers/getting-started.html)
- [Raspberry Pi 4 specifications](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/)
- [Raspberry Pi power supply guidance](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#power-supply)
- [Docker Engine on Debian](https://docs.docker.com/engine/install/debian/)
- [Docker Linux post-install steps](https://docs.docker.com/engine/install/linux-postinstall/)
- [Docker Engine on Raspberry Pi OS 32-bit](https://docs.docker.com/engine/install/raspberry-pi-os/)
