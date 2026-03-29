#include <Arduino.h>
#include "app_wifi.h"
#include <stdio.h>
#include <string.h>
#include <WiFi.h>
#include "lvgl.h"
#include "../../bsp_lv_port.h"
#include "../lvgl_ui/lvgl_ui.h"

#include <NetworkClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>

char g_sta_ssid[50];
char g_sta_pass[50];


WebServer server(80);

// const int led = 13;

void handleRoot() {
  // digitalWrite(led, 1);
  server.send(200, "text/plain", "hello from esp32!");
  // digitalWrite(led, 0);
}

void handleNotFound() {
  // digitalWrite(led, 1);
  String message = "File Not Found\n\n";
  message += "URI: ";
  message += server.uri();
  message += "\nMethod: ";
  message += (server.method() == HTTP_GET) ? "GET" : "POST";
  message += "\nArguments: ";
  message += server.args();
  message += "\n";
  for (uint8_t i = 0; i < server.args(); i++) {
    message += " " + server.argName(i) + ": " + server.arg(i) + "\n";
  }
  server.send(404, "text/plain", message);
  // digitalWrite(led, 0);
}



void app_wifi_task(void *arg) {
  char str[20];
  IPAddress ip;
  String ipString;
  char ipCharArray[16];
  while (1) {
    ip = WiFi.localIP();
    ipString = ip.toString();
    ipString.toCharArray(ipCharArray, sizeof(ipCharArray));

    if (lvgl_lock(-1)) {
      lv_label_set_text(label_wifi_sta_ip, ipCharArray);  // 初始值
      lvgl_unlock();
    }

    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

void app_web_server_task(void *arg) {
  if (MDNS.begin("esp32")) {
    Serial.println("MDNS responder started");
  }

  server.on("/", handleRoot);

  server.on("/inline", []() {
    server.send(200, "text/plain", "this works as well");
  });

  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP server started");
  while (1) {
    server.handleClient();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}


void app_wifi_mode_change(uint8_t mode) {
  switch (mode) {
    case 1:
      WiFi.begin(g_sta_ssid, g_sta_pass);
      break;
    default:
      WiFi.mode(WIFI_MODE_NULL);
      break;
  }
}

void app_wifi_init(char *sta_ssid, char *sta_pass) {
  memcpy(g_sta_ssid, sta_ssid, strlen(sta_ssid) + 1);
  memcpy(g_sta_pass, sta_pass, strlen(sta_pass) + 1);
  
  wifi_set_mode_change_cb(app_wifi_mode_change);


  WiFi.begin(g_sta_ssid, g_sta_pass);

  if (lvgl_lock(-1)) {
    lv_label_set_text(label_wifi_sta_ssid, g_sta_ssid);  // 初始值
    lv_label_set_text(label_wifi_sta_pass, g_sta_pass);  // 初始值
    lvgl_unlock();
  }
}

void app_wifi_run(void) {
  // xTaskCreate(app_web_server_task, "app_web_server_task", 1024*5, NULL, 2, NULL);
  xTaskCreate(app_wifi_task, "app_wifi_task", 1024*5, NULL, 1, NULL);
}
