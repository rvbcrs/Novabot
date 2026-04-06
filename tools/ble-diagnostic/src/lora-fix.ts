/**
 * LoRa Fix — Query mower's actual STM32 LoRa channel via SSH,
 * then set the charger to match via BLE.
 *
 * The mower's STM32 stores its own LoRa config in Flash/EEPROM.
 * Editing json_config.json does NOT change the STM32's channel.
 * chassis_control_node logs the actual channel on startup:
 *   "lora channel:15,addr:718"
 *
 * The charger must be on the same channel for LoRa communication.
 * After set_lora_info, the charger does a channel scan (lc→hc)
 * and autonomously picks the best channel. If hc=lc=channel,
 * it's forced to stay on that exact channel.
 */

import { Client as SSHClient } from 'ssh2';

export interface MowerLoraConfig {
  channel: number;
  addr: number;
  source: string; // Where the data came from (log line)
}

/**
 * SSH to mower and read the actual STM32 LoRa channel from
 * chassis_control_node's log.
 */
export function getMowerLoraConfig(
  host: string,
  password = 'novabot',
): Promise<MowerLoraConfig> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();

    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH timeout (10s)'));
    }, 10000);

    conn.on('ready', () => {
      clearTimeout(timeout);

      // Read the most recent chassis_control_node log and grep for lora config
      const cmd = `grep "lora channel:" $(ls -t /root/novabot/data/ros2_log/chassis_control_node_*.log 2>/dev/null | head -1) 2>/dev/null | tail -1`;

      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let output = '';
        stream.on('data', (data: Buffer) => {
          output += data.toString();
        });

        stream.on('close', () => {
          conn.end();

          // Parse: "lora channel:15,addr:718"
          const match = output.match(/lora channel:(\d+),addr:(\d+)/);
          if (!match) {
            return reject(new Error(`Could not parse LoRa config from log. Output: "${output.trim()}"`));
          }

          resolve({
            channel: parseInt(match[1], 10),
            addr: parseInt(match[2], 10),
            source: output.trim(),
          });
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username: 'root',
      password,
      readyTimeout: 10000,
      algorithms: {
        serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
      },
    });
  });
}
