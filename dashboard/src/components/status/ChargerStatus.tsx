import type { DeviceState } from '../../types';
import { BatteryGauge } from '../sensors/BatteryGauge';
import { WorkProgress } from './WorkProgress';
import { ErrorDisplay } from './ErrorDisplay';
import { SensorGrid } from '../sensors/SensorGrid';

interface Props {
  device: DeviceState;
}

export function ChargerStatus({ device }: Props) {
  const s = device.sensors;
  const battery = parseInt(s.battery_capacity ?? '0', 10);
  const progress = parseInt(s.mowing_progress ?? '0', 10);

  return (
    <div className="space-y-4">
      <ErrorDisplay
        errorCode={s.error_code}
        errorMsg={s.error_msg}
        errorStatus={s.error_status}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {battery > 0 && <BatteryGauge percentage={battery} />}
        {progress > 0 && <WorkProgress progress={progress} />}
      </div>

      <SensorGrid device={device} />
    </div>
  );
}
