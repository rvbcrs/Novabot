/**
 * Extended Commands — stuur commando's naar het extended_commands.py node op de maaier.
 *
 * Topic: novabot/extended/<SN> (onversleuteld, apart van mqtt_node)
 * Response: novabot/extended_response/<SN>
 *
 * Dit zijn commando's die NIET in mqtt_node zitten maar door een apart
 * Python ROS2 node op de maaier worden afgehandeld.
 */
import { publishToTopic } from './mapSync.js';

/**
 * Stuur een commando naar het extended_commands.py node op de maaier.
 */
export function publishExtendedCommand(sn: string, command: Record<string, unknown>): void {
  publishToTopic(`novabot/extended/${sn}`, command);
}
