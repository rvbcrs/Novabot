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
import { isFrameNavBlocked } from '../services/frameValidation.js';

/**
 * Stuur een commando naar het extended_commands.py node op de maaier.
 *
 * Veiligheid: zolang het map-frame niet gevalideerd is (na een bundle-restore,
 * vóór het her-ankeren) worden bewegingscommando's hier geblokkeerd, met
 * dezelfde predicaat als publishToDevice. Dit kanaal draagt start_edge_cut en
 * mow_zone — allebei commando's die de maaier autonoom het map-frame laten
 * afrijden — en had tot nu toe GEEN guard: de rand-dag watcher, de app en het
 * dashboard konden dus na een restore een randmaai in een ongeldig frame
 * starten. Niet weghalen zonder de guard elders op dit kanaal terug te zetten.
 */
export function publishExtendedCommand(sn: string, command: Record<string, unknown>): void {
  if (isFrameNavBlocked(sn, command)) {
    console.warn(`[ExtendedCommands] GEBLOKKEERD ${Object.keys(command)[0]} voor ${sn}: frame niet gevalideerd (post-restore). Eerst her-ankeren via de dock-cyclus.`);
    return;
  }
  publishToTopic(`novabot/extended/${sn}`, command);
}
