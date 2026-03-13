/**
 * Express + Socket.io server for BLE Diagnostic Tool.
 *
 * Serves the React dashboard and provides API routes for:
 *   - BLE scan, connect, disconnect, diagnostic commands
 *   - MQTT broker connection and mower commands
 *   - Provisioning (set WiFi, LoRa, MQTT, commit)
 */

import express from 'express';
import { createServer } from 'http';
import { Server as IOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';

import * as ble from './ble.js';
import * as mqttClient from './mqtt.js';
import * as serialMonitor from './serial-monitor.js';
import * as loraFix from './lora-fix.js';

export function createApp() {
  const app = express();
  const httpServer = createServer(app);
  const io = new IOServer(httpServer, {
    cors: { origin: '*' },
  });

  app.use(express.json());

  // ── Static files (wizard bundle or dev proxy) ───────────────────────────

  // Try wizard-bundle first (production), fall back to wizard/dist (dev build)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wizardFiles } = require('./wizard-bundle.js');
    const MIME: Record<string, string> = {
      '.html': 'text/html',
      '.js':   'application/javascript',
      '.css':  'text/css',
      '.svg':  'image/svg+xml',
      '.png':  'image/png',
      '.ico':  'image/x-icon',
      '.json': 'application/json',
    };

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
        return next();
      }
      let filePath = req.path === '/' ? 'index.html' : req.path.slice(1);
      let buf = wizardFiles[filePath];
      if (!buf) {
        filePath = 'index.html'; // SPA fallback
        buf = wizardFiles[filePath];
      }
      if (buf) {
        const ext = path.extname(filePath);
        res.type(MIME[ext] || 'application/octet-stream');
        res.send(buf);
      } else {
        next();
      }
    });
  } catch {
    // No bundle — serve from wizard/dist if it exists (dev mode)
    const wizardDist = path.join(__dirname, '..', 'wizard', 'dist');
    if (fs.existsSync(wizardDist)) {
      app.use(express.static(wizardDist));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
          return next();
        }
        res.sendFile(path.join(wizardDist, 'index.html'));
      });
    }
  }

  // ── Server Info ──────────────────────────────────────────────────────────

  app.get('/api/server-info', (_req, res) => {
    // Return the server's LAN IP for provisioning defaults
    const os = require('os');
    const nets = os.networkInterfaces();
    let ip = '';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          ip = net.address;
          break;
        }
      }
      if (ip) break;
    }
    res.json({ ip, hostname: os.hostname() });
  });

  // ── BLE Routes ────────────────────────────────────────────────────────────

  app.get('/api/ble/status', async (_req, res) => {
    try {
      const status = await ble.getBleStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/ble/scan', async (_req, res) => {
    try {
      const duration = 15000;
      res.json({ ok: true, duration });

      await ble.scanDevices(
        (device) => io.emit('ble:scan-result', device),
        (count) => io.emit('ble:scan-done', { count }),
        duration,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      io.emit('ble:scan-done', { count: 0, error: msg });
    }
  });

  app.post('/api/ble/stop-scan', async (_req, res) => {
    await ble.stopScan();
    res.json({ ok: true });
  });

  app.post('/api/ble/connect', async (req, res) => {
    try {
      const { mac } = req.body;
      if (!mac) return res.status(400).json({ error: 'mac required' });

      const device = await ble.connectDevice(mac);
      io.emit('ble:connected', {
        mac: device.mac,
        name: device.name,
        type: device.type,
      });
      res.json({ ok: true, mac: device.mac, name: device.name, type: device.type });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/ble/disconnect', async (req, res) => {
    try {
      const { mac } = req.body;
      if (!mac) return res.status(400).json({ error: 'mac required' });

      await ble.disconnectDevice(mac);
      io.emit('ble:disconnected', { mac });
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/ble/connected', (_req, res) => {
    const devices = ble.getConnectedDevices().map(d => ({
      mac: d.mac,
      name: d.name,
      type: d.type,
    }));
    res.json(devices);
  });

  // ── BLE Diagnostic Commands ───────────────────────────────────────────────

  app.get('/api/ble/device/:mac/info', async (req, res) => {
    try {
      const results = await ble.readAllDiagnostics(req.params.mac);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/ble/device/:mac/signal', async (req, res) => {
    try {
      const result = await ble.readSignalInfo(req.params.mac);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/ble/device/:mac/lora', async (req, res) => {
    try {
      const result = await ble.readLoraInfo(req.params.mac);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/ble/device/:mac/dev-info', async (req, res) => {
    try {
      const result = await ble.readDevInfo(req.params.mac);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/ble/device/:mac/cfg', async (req, res) => {
    try {
      const result = await ble.readCfgInfo(req.params.mac);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/ble/device/:mac/wifi-rssi', async (req, res) => {
    try {
      const result = await ble.readWifiRssi(req.params.mac);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── BLE Provisioning ─────────────────────────────────────────────────────

  app.post('/api/ble/device/:mac/set-wifi', async (req, res) => {
    try {
      const { ssid, password, deviceType } = req.body;
      const result = await ble.setWifi(req.params.mac, { ssid, password, deviceType });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/ble/device/:mac/set-lora', async (req, res) => {
    try {
      const { addr, channel, hc, lc } = req.body;
      const result = await ble.setLora(req.params.mac, { addr, channel, hc, lc });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/ble/device/:mac/set-mqtt', async (req, res) => {
    try {
      const { addr, port } = req.body;
      const result = await ble.setMqtt(req.params.mac, { addr, port });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/ble/device/:mac/commit', async (req, res) => {
    try {
      const { deviceType } = req.body;
      const result = await ble.commitConfig(req.params.mac, deviceType ?? 'charger');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── MQTT Routes ───────────────────────────────────────────────────────────

  app.get('/api/mqtt/status', (_req, res) => {
    res.json(mqttClient.getMqttStatus());
  });

  app.post('/api/mqtt/connect', async (req, res) => {
    try {
      const { host, port } = req.body;
      if (!host) return res.status(400).json({ error: 'host required' });
      await mqttClient.connectBroker(host, port ?? 1883);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/mqtt/disconnect', (_req, res) => {
    mqttClient.disconnectBroker();
    res.json({ ok: true });
  });

  app.post('/api/mqtt/subscribe/:sn', (req, res) => {
    mqttClient.subscribeDevice(req.params.sn);
    res.json({ ok: true });
  });

  app.post('/api/mqtt/device/:sn/lora', async (req, res) => {
    try {
      const result = await mqttClient.queryMowerLoraInfo(req.params.sn);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/mqtt/device/:sn/dev-info', async (req, res) => {
    try {
      const result = await mqttClient.queryMowerDevInfo(req.params.sn);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/mqtt/device/:sn/para-info', async (req, res) => {
    try {
      const result = await mqttClient.queryMowerParaInfo(req.params.sn);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Serial Monitor Routes ─────────────────────────────────────────────────

  app.get('/api/serial/status', (_req, res) => {
    res.json({ ...serialMonitor.getStatus(), stats: serialMonitor.getStats() });
  });

  app.post('/api/serial/connect', async (req, res) => {
    try {
      const { host, password } = req.body;
      if (!host) return res.status(400).json({ error: 'host required' });
      await serialMonitor.connectMower(host, password);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/serial/disconnect', (_req, res) => {
    serialMonitor.disconnectMower();
    res.json({ ok: true });
  });

  // ── LoRa Fix Routes ──────────────────────────────────────────────────────

  // Query the mower's actual STM32 LoRa channel via SSH
  app.post('/api/lora/mower-config', async (req, res) => {
    try {
      const { host, password } = req.body;
      if (!host) return res.status(400).json({ error: 'host required' });
      const config = await loraFix.getMowerLoraConfig(host, password);
      res.json({ ok: true, ...config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Full fix: query mower channel via SSH, then set charger to match via BLE
  app.post('/api/lora/fix', async (req, res) => {
    try {
      const { mowerHost, mowerPassword, chargerMac } = req.body;
      if (!mowerHost) return res.status(400).json({ error: 'mowerHost required' });
      if (!chargerMac) return res.status(400).json({ error: 'chargerMac required' });

      // Step 1: Get mower's actual LoRa channel
      const mowerConfig = await loraFix.getMowerLoraConfig(mowerHost, mowerPassword);

      // Step 2: Set charger to the same channel via BLE
      // Use hc=lc=channel to force the charger to stay on this exact channel
      const bleResult = await ble.setLora(chargerMac, {
        addr: mowerConfig.addr,
        channel: mowerConfig.channel,
        hc: mowerConfig.channel,
        lc: mowerConfig.channel,
      });

      res.json({
        ok: bleResult.ok,
        mowerChannel: mowerConfig.channel,
        mowerAddr: mowerConfig.addr,
        bleResult,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Socket.io ─────────────────────────────────────────────────────────────

  // Forward MQTT sensor data to connected clients
  mqttClient.onSensorData((sn, data) => {
    io.emit('mqtt:data', { sn, data });
  });

  // Forward serial monitor frames and stats to clients
  serialMonitor.onFrame((frame) => {
    io.emit('serial:frame', frame);
  });

  serialMonitor.onStats((stats) => {
    io.emit('serial:stats', stats);
  });

  serialMonitor.onStatus((status) => {
    io.emit('serial:status', status);
  });

  serialMonitor.startStatsEmitter();

  io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`[Socket.io] Client disconnected: ${socket.id}`);
    });
  });

  return { app, httpServer, io };
}
