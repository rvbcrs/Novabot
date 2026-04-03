/**
 * Novabot Mower Simulator — Node.js single-threaded implementation.
 *
 * Single event loop = no socket corruption between MQTT and HTTP.
 * Uses mqtt.js (Paho-compatible) + native http module.
 *
 * Usage:
 *   cd research/simulator && npm install && npm start
 *
 * Connect laptop to OpenNova-Setup WiFi first.
 */

import * as mqtt from 'mqtt';
import * as http from 'http';
import * as fs from 'fs';
import { createHash } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────────────

const SN = process.env.SN || 'LFIN0000000001';
const BROKER = process.env.BROKER || '10.0.0.1';
const PORT = parseInt(process.env.MQTT_PORT || '1883');
const CHARGING = (process.env.CHARGING || 'true') === 'true';
const BATTERY = parseInt(process.env.BATTERY || '85');
const STOCK_MODE = (process.env.STOCK || 'false') === 'true';
let firmwareVersion = process.env.FW_VERSION || 'v0.0.0-simulator';

const REPORT_INTERVAL = 10_000; // ms
const TOPIC_RX = `Dart/Send_mqtt/${SN}`;
const TOPIC_TX = `Dart/Receive_mqtt/${SN}`;
const TOPIC_EXT = `novabot/extended/${SN}`;
const TOPIC_EXT_RESP = `novabot/extended_response/${SN}`;

let otaInProgress = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] [SIM] ${msg}`);
}

function pub(client: mqtt.MqttClient, topic: string, data: object) {
    client.publish(topic, JSON.stringify(data), { qos: 0 });
}

// ── Main MQTT Client (simulates mqtt_node) ──────────────────────────────────

const mainClientId = `${SN}_6688_${Math.floor(Math.random() * 10000)}`;
const client = mqtt.connect(`mqtt://${BROKER}:${PORT}`, {
    clientId: mainClientId,
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
});

client.on('connect', () => {
    log(`MQTT connected: ${mainClientId}`);
    client.subscribe(TOPIC_RX, { qos: 0 }, (err, granted) => {
        if (err) log(`Subscribe error: ${err.message}`);
        else log(`Subscribed to: ${TOPIC_RX} (QoS ${granted?.[0]?.qos})`);
    });
});

client.on('error', (err) => log(`MQTT error: ${err.message}`));
client.on('reconnect', () => log('MQTT reconnecting...'));

client.on('message', (topic, payload) => {
    log(`MSG on ${topic} (${payload.length} bytes)`);
    try {
        const data = JSON.parse(payload.toString());
        const keys = Object.keys(data);

        if (data.ota_upgrade_cmd) {
            handleOta(data.ota_upgrade_cmd);
        } else if (data.set_wifi_info) {
            log(`WiFi config received`);
        } else if (data.set_mqtt_info) {
            const addr = data.set_mqtt_info.addr || '?';
            log(`MQTT info: ${addr}`);
            if (STOCK_MODE && !addr.includes('lfibot')) {
                log(`REJECTED: stock firmware only accepts *.lfibot.com`);
            }
        } else {
            log(`CMD: ${keys.join(', ')}`);
        }
    } catch {
        log(`Non-JSON payload (${payload.length} bytes)`);
    }
});

// ── Extended Commands Client (simulates extended_commands.py) ────────────────

let extClient: mqtt.MqttClient | null = null;

if (!STOCK_MODE) {
    const extClientId = `ext_cmd_${SN}_${Math.floor(Math.random() * 10000)}`;
    extClient = mqtt.connect(`mqtt://${BROKER}:${PORT}`, {
        clientId: extClientId,
        protocolId: 'MQTT',
        protocolVersion: 4,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 5000,
    });

    extClient.on('connect', () => {
        log(`EXT connected: ${extClientId}`);
        extClient!.subscribe(TOPIC_EXT, { qos: 0 });
    });

    extClient.on('message', (_topic, payload) => {
        try {
            const data = JSON.parse(payload.toString());
            const keys = Object.keys(data);

            if (data.get_system_info !== undefined) {
                pub(extClient!, TOPIC_EXT_RESP, {
                    get_system_info_respond: {
                        firmware_version: firmwareVersion,
                        cpu_temp_c: 42.0,
                        uptime_s: 300,
                        mem_total_mb: 2048,
                        mem_free_mb: 1200,
                    },
                });
                log(`System info sent (fw: ${firmwareVersion})`);
            } else if (data.set_mqtt_config) {
                const addr = data.set_mqtt_config.addr || '?';
                pub(extClient!, TOPIC_EXT_RESP, {
                    set_mqtt_config_respond: { result: 0, addr },
                });
                log(`MQTT config -> ${addr}`);
            } else if (data.set_wifi_config) {
                const ssid = data.set_wifi_config.ssid || '?';
                pub(extClient!, TOPIC_EXT_RESP, {
                    set_wifi_config_respond: { result: 0, ssid },
                });
                log(`WiFi config -> ${ssid}`);
            } else if (data.clean_ota_cache !== undefined) {
                pub(extClient!, TOPIC_EXT_RESP, {
                    clean_ota_cache_respond: { result: 0 },
                });
                log('OTA cache cleaned, rebooting...');
                simulateReboot();
            } else if (data.set_robot_reboot !== undefined) {
                pub(extClient!, TOPIC_EXT_RESP, {
                    set_robot_reboot_respond: { result: 0 },
                });
                log('Reboot requested...');
                simulateReboot();
            } else {
                log(`EXT CMD: ${keys.join(', ')}`);
            }
        } catch {
            log(`Non-JSON ext payload`);
        }
    });
}

// ── Status Reporting ────────────────────────────────────────────────────────

const reportTimer = setInterval(() => {
    if (otaInProgress) return;

    pub(client, TOPIC_TX, {
        report_state_robot: {
            battery_power: BATTERY,
            cpu_temperature: 42,
            cpu_usage: 8,
            error_msg: 'Error_code: 151 Please input pin to unlock robot!!!',
            error_status: 151,
            loc_quality: 100,
            recharge_status: CHARGING ? 9 : 0,
            msg: `Mode:COVERAGE Work:WAIT Recharge: ${CHARGING ? 'FINISHED' : 'IDLE'}`,
            task_mode: 1,
            work_status: 0,
            x: 0, y: 0, theta: 0,
        },
    });

    pub(client, TOPIC_TX, {
        report_state_timer_data: {
            battery_capacity: BATTERY,
            battery_state: CHARGING ? 'CHARGING' : 'NOT_CHARGING',
            timer_task: 0,
        },
    });

    log(`Status sent (battery=${BATTERY}%, charging=${CHARGING})`);
}, REPORT_INTERVAL);

// ── OTA Handler ─────────────────────────────────────────────────────────────

function handleOta(cmd: {
    url?: string;
    version?: string;
    md5?: string;
}) {
    const url = cmd.url || '';
    const version = cmd.version || '?';
    const expectedMd5 = cmd.md5 || '';

    log(`OTA: ${version} from ${url}`);
    log(`Expected MD5: ${expectedMd5}`);

    if (!CHARGING) {
        log('OTA REJECTED: not charging');
        return;
    }

    otaInProgress = true;
    pub(client, TOPIC_TX, {
        ota_upgrade_state: { percentage: 0, status: 'upgrade' },
    });

    downloadFirmware(url, expectedMd5, version);
}

function downloadFirmware(url: string, expectedMd5: string, version: string) {
    const outPath = `/tmp/sim_fw_${SN}.deb`;
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    let totalBytes = 0;
    let downloadedBytes = 0;
    let lastReportedPct = -1;

    const doDownload = (startByte: number) => {
        const headers: Record<string, string> = {};
        if (startByte > 0) {
            headers['Range'] = `bytes=${startByte}-`;
            log(`Resuming from byte ${startByte}`);
        }

        const req = http.get(url, { headers, timeout: 120_000 }, (res) => {
            if (res.statusCode !== 200 && res.statusCode !== 206) {
                log(`HTTP error: ${res.statusCode}`);
                pub(client, TOPIC_TX, {
                    ota_upgrade_state: { percentage: 0, status: 'fail' },
                });
                otaInProgress = false;
                return;
            }

            if (startByte === 0 && res.headers['content-length']) {
                totalBytes = parseInt(res.headers['content-length'], 10);
                log(`File size: ${totalBytes} bytes`);
            }

            const fileStream = fs.createWriteStream(outPath, {
                flags: startByte === 0 ? 'w' : 'a',
            });

            res.on('data', (chunk: Buffer) => {
                downloadedBytes += chunk.length;
                fileStream.write(chunk);

                if (totalBytes > 0) {
                    const progress = downloadedBytes / totalBytes;
                    const pctInt = Math.floor(progress * 62); // 0-62% = download phase

                    if (pctInt >= lastReportedPct + 2) {
                        lastReportedPct = pctInt;
                        pub(client, TOPIC_TX, {
                            ota_upgrade_state: {
                                percentage: progress * 0.62,
                                status: 'upgrade',
                            },
                        });
                        log(`Download: ${pctInt}% (${downloadedBytes} bytes)`);
                    }
                }
            });

            res.on('end', () => {
                fileStream.end(() => {
                    if (downloadedBytes >= totalBytes && totalBytes > 0) {
                        verifyAndInstall(outPath, expectedMd5, version);
                    } else {
                        log(`Incomplete download: ${downloadedBytes}/${totalBytes}`);
                        pub(client, TOPIC_TX, {
                            ota_upgrade_state: { percentage: 0, status: 'fail' },
                        });
                        otaInProgress = false;
                    }
                });
            });

            res.on('error', (err) => {
                log(`HTTP stream error: ${err.message}`);
                fileStream.end();
                // Attempt resume after 2s
                if (downloadedBytes < totalBytes && downloadedBytes > 0) {
                    log(`Will resume in 2s from byte ${downloadedBytes}...`);
                    setTimeout(() => doDownload(downloadedBytes), 2000);
                } else {
                    pub(client, TOPIC_TX, {
                        ota_upgrade_state: { percentage: 0, status: 'fail' },
                    });
                    otaInProgress = false;
                }
            });
        });

        req.on('error', (err) => {
            log(`HTTP request error: ${err.message}`);
            if (downloadedBytes > 0 && downloadedBytes < totalBytes) {
                log(`Will resume in 2s from byte ${downloadedBytes}...`);
                setTimeout(() => doDownload(downloadedBytes), 2000);
            } else {
                pub(client, TOPIC_TX, {
                    ota_upgrade_state: { percentage: 0, status: 'fail' },
                });
                otaInProgress = false;
            }
        });

        req.on('timeout', () => {
            log('HTTP timeout');
            req.destroy();
        });
    };

    doDownload(0);
}

function verifyAndInstall(filePath: string, expectedMd5: string, version: string) {
    log('Download complete, verifying MD5...');

    const fileBuffer = fs.readFileSync(filePath);
    const actualMd5 = createHash('md5').update(fileBuffer).digest('hex');
    log(`MD5: ${actualMd5} (expected: ${expectedMd5})`);

    try { fs.unlinkSync(filePath); } catch {}

    if (expectedMd5 && actualMd5 !== expectedMd5) {
        log('MD5 MISMATCH!');
        pub(client, TOPIC_TX, {
            ota_upgrade_state: { percentage: 0, status: 'fail' },
        });
        otaInProgress = false;
        return;
    }

    log('MD5 OK! Simulating unpack + install...');

    // Unpack phase (62-68%)
    const unpackSteps = [0.63, 0.65, 0.68];
    let step = 0;

    const unpackTimer = setInterval(() => {
        if (step < unpackSteps.length) {
            pub(client, TOPIC_TX, {
                ota_upgrade_state: {
                    percentage: unpackSteps[step],
                    status: 'upgrade',
                },
            });
            log(`Unpack: ${Math.round(unpackSteps[step] * 100)}%`);
            step++;
        } else {
            clearInterval(unpackTimer);
            doInstall(version);
        }
    }, 1000);
}

function doInstall(version: string) {
    log('Installing...');
    let pct = 70;

    const installTimer = setInterval(() => {
        if (pct <= 100) {
            pub(client, TOPIC_TX, {
                ota_upgrade_state: {
                    percentage: pct / 100,
                    status: 'upgrade',
                },
            });
            log(`Install: ${pct}%`);
            pct += 10;
        } else {
            clearInterval(installTimer);

            log(`OTA SUCCESS! Version: ${version}`);
            firmwareVersion = version;

            pub(client, TOPIC_TX, {
                ota_upgrade_state: { percentage: 1.0, status: 'success' },
            });

            // Wait 3s then reboot
            setTimeout(() => simulateReboot(), 3000);
        }
    }, 1000);
}

// ── Reboot Simulation ───────────────────────────────────────────────────────

function simulateReboot() {
    log('Rebooting (offline 30s)...');
    otaInProgress = false;

    client.end(true);
    if (extClient) extClient.end(true);

    setTimeout(() => {
        log('Reboot complete, reconnecting with new client IDs...');
        // mqtt.js reconnect reuses the old client ID which gets rejected
        // Force new options with random suffix
        (client.options as any).clientId = `${SN}_6688_${Math.floor(Math.random() * 10000)}`;
        client.reconnect();
        if (extClient) {
            (extClient.options as any).clientId = `ext_cmd_${SN}_${Math.floor(Math.random() * 10000)}`;
            extClient.reconnect();
        }
    }, 30_000);
}

// ── Startup ─────────────────────────────────────────────────────────────────

console.log('='.repeat(50));
console.log('  Novabot Mower Simulator (Node.js)');
console.log(`  SN: ${SN}  Broker: ${BROKER}:${PORT}`);
console.log(`  Mode: ${STOCK_MODE ? 'STOCK' : 'CUSTOM'}  Charging: ${CHARGING}`);
console.log(`  Firmware: ${firmwareVersion}`);
console.log('='.repeat(50));
