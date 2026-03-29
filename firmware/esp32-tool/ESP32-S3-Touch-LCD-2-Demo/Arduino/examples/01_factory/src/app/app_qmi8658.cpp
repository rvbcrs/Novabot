#include <Arduino.h>
#include "FastIMU.h"
#include <Wire.h>
#include "../lvgl_ui/lvgl_ui.h"
#include "../../bsp_i2c.h"
#include "../../bsp_lv_port.h"
#include "string.h"

#define IMU_ADDRESS 0x6B     //Change to the address of the IMU
#define PERFORM_CALIBRATION  //Comment to disable startup calibration
QMI8658 IMU;                 //Change to the name of any supported IMU!

// Currently supported IMUS: MPU9255 MPU9250 MPU6886 MPU6500 MPU6050 ICM20689 ICM20690 BMI055 BMX055 BMI160 LSM6DS3 LSM6DSL QMI8658

calData calib = { 0 };  //Calibration data
AccelData accelData;    //Sensor data
GyroData gyroData;
MagData magData;


void app_qmi8658_task(void *arg) {
  char str[20];
  while (1) {
    if (bsp_i2c_lock(-1)) {
      IMU.update();
      IMU.getAccel(&accelData);
      IMU.getGyro(&gyroData);
      if (IMU.hasTemperature()) {
        // Serial.print("\t");
        // Serial.println(IMU.getTemp());
      }
      bsp_i2c_unlock();
    }

    if (lvgl_lock(-1)) {

      snprintf(str, sizeof(str), "%.2f", accelData.accelX);
      lv_label_set_text(label_accel_x, str);  // 初始值

      snprintf(str, sizeof(str), "%.2f", accelData.accelY);
      lv_label_set_text(label_accel_y, str);  // 初始值

      snprintf(str, sizeof(str), "%.2f", accelData.accelZ);
      lv_label_set_text(label_accel_z, str);  // 初始值

      snprintf(str, sizeof(str), "%.2f", gyroData.gyroX);
      lv_label_set_text(label_gyro_x, str);  // 初始值

      snprintf(str, sizeof(str), "%.2f", gyroData.gyroY);
      lv_label_set_text(label_gyro_y, str);  // 初始值

      snprintf(str, sizeof(str), "%.2f", gyroData.gyroZ);
      lv_label_set_text(label_gyro_z, str);  // 初始值
      lvgl_unlock();
    }


    // Serial.print(accelData.accelX);
    // Serial.print("\t");
    // Serial.print(accelData.accelY);
    // Serial.print("\t");
    // Serial.print(accelData.accelZ);
    // Serial.print("\t");
    // Serial.print(gyroData.gyroX);
    // Serial.print("\t");
    // Serial.print(gyroData.gyroY);
    // Serial.print("\t");
    // Serial.print(gyroData.gyroZ);

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}


void app_qmi8658_init(void) {

  int err = IMU.init(calib, IMU_ADDRESS);
  if (err != 0) {
    Serial.print("Error initializing IMU: ");
    Serial.println(err);
    while (true) {
      ;
    }
  }

#if 0
  Serial.println("FastIMU calibration & data example");
  if (IMU.hasMagnetometer()) {
    delay(1000);
    Serial.println("Move IMU in figure 8 pattern until done.");
    delay(3000);
    IMU.calibrateMag(&calib);
    Serial.println("Magnetic calibration done!");
  } else {
    delay(5000);
  }

  delay(5000);
  Serial.println("Keep IMU level.");
  delay(5000);
  IMU.calibrateAccelGyro(&calib);
  Serial.println("Calibration done!");
  Serial.println("Accel biases X/Y/Z: ");
  Serial.print(calib.accelBias[0]);
  Serial.print(", ");
  Serial.print(calib.accelBias[1]);
  Serial.print(", ");
  Serial.println(calib.accelBias[2]);
  Serial.println("Gyro biases X/Y/Z: ");
  Serial.print(calib.gyroBias[0]);
  Serial.print(", ");
  Serial.print(calib.gyroBias[1]);
  Serial.print(", ");
  Serial.println(calib.gyroBias[2]);
  if (IMU.hasMagnetometer()) {
    Serial.println("Mag biases X/Y/Z: ");
    Serial.print(calib.magBias[0]);
    Serial.print(", ");
    Serial.print(calib.magBias[1]);
    Serial.print(", ");
    Serial.println(calib.magBias[2]);
    Serial.println("Mag Scale X/Y/Z: ");
    Serial.print(calib.magScale[0]);
    Serial.print(", ");
    Serial.print(calib.magScale[1]);
    Serial.print(", ");
    Serial.println(calib.magScale[2]);
  }
  // delay(5000);
  IMU.init(calib, IMU_ADDRESS);
#endif

  if (err != 0) {
    Serial.print("Error Setting range: ");
    Serial.println(err);
    while (true) {
      ;
    }
  }

  
}


void app_qmi8658_run(void)
{
  xTaskCreate(app_qmi8658_task, "qmi8658_task", 4096, NULL, 1, NULL);
}
