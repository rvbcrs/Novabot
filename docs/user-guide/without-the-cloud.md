# Without the Novabot Cloud

This page is for the case where **Connect & Import from Cloud** cannot work:
the Novabot cloud no longer answers, your login is refused, or this mower was
never in your account (a second-hand one, for example). OpenNova does not need
the cloud for anything after the first import, and the one thing the import
normally brings that matters, the map, lives on the mower itself. Here is what
happens when you start from a local account instead.

## What you lose, what you keep

Not imported, because it only existed in the cloud:

- your account and the list of devices bound to it
- the cloud copy of your maps
- schedules, mowing settings and the mower's nickname
- mowing history

Kept, because it lives on the hardware:

- the maps, on the mower's own disk; OpenNova gets them from there
- the pairing between charger and mower (LoRa) and the charger's RTK base
- the firmware, stock or custom

## Step 1: Create the local account

On the setup page of the admin panel choose **Skip cloud import — create local
account only**, then type your own email address and a password (at least 6
characters, twice). That makes the admin account; you add other people later
under Settings > Users. The wizard then continues with the certificate step as
usual; see [First Run](../guide/getting-started.md).

If the cloud comes back later, **Cloud import** under admin Settings still
works and keeps what you set up locally.

## Step 2: Add your charger and mower

Log into the app (the official Novabot app or the
[OpenNova app](opennova-app.md)) with the email and password from step 1. The device list
is empty, so add the charger first and then the mower, exactly like a first
setup: the app provisions them over Bluetooth with your Wi-Fi and your server
address. The mower and charger must resolve `mqtt.lfibot.com` to your server
for this, see [DNS Setup](../guide/dns-setup.md). Adding a device by serial
number and BLE MAC by hand is also possible in the
[dashboard](dashboard.md#adding-a-device).

## Step 3: The map comes from the mower

Once the mower is online, OpenNova notices it has no map for it and asks the
mower for one by itself. It waits about a minute and a half after the connect
(a command right after connecting crashes the mower's MQTT node on some units),
then sends the same request the official app uses to fetch a map. The mower
zips its map files and uploads them to your server; the map tab shows
**Getting the map from the mower** in the meantime. This works on stock and on
custom firmware.

The request is only sent while the database has no map for the mower. A mapping
session, a running map operation or a map frame that still needs re-anchoring
postpones it to the next connect.

**No map found** means nothing usable came back. Then either restore a backup
in the admin panel under **Maps** (a portable backup or a plain CSV zip, see
[Map Backup & Restore](map-backup-restore.md)), or make a new map with the app.
The next time the mower connects, OpenNova asks again.

## Step 4: Check the map before the first mow

The map you now see is the mower's own, in the mower's own coordinate frame.
Nothing was converted, so the mower mows exactly where it did before and no
re-anchor is needed.

What can be off is the **picture**. With a cloud import the charger's position
on the satellite photo came from the cloud; without it, OpenNova places the
charger where the docked mower's GPS says it stands. That GPS carries the
error of the charger's own RTK base, which can be metres. So:

- The mower mows the right spot, but the zone is drawn next to the lawn on the
  photo: use **Display alignment** (satellite view only). It moves the picture,
  not the map.
- The mower really mows off, for instance after the charger was moved: use
  **Nudge** on the zone. Drive the mower onto a corner of the lawn, click that
  corner, and the zone and its obstacles shift by the measured difference. See
  [Editing maps](dashboard.md#editing-maps).

Also check that the channels between your zones and to the dock are there, and
run the **coverage preview** once before the first mow.

## Step 5: Set up the rest again

Schedules, cutting height and the other mowing settings, the nickname and
notifications are not imported from anywhere; set them again in the dashboard
or the app. Mowing history starts empty.

## Make a backup now

There is no cloud copy of your map any more. Take a portable backup from the
admin panel under **Maps** as soon as the map is in, and again after every map
edit. [Map Backup & Restore](map-backup-restore.md) explains the format and
the restore.
