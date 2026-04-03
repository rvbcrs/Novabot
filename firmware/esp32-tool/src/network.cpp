#include "network.h"
#include "config.h"
#include "mqtt.h"
#include "display.h"

#include <WiFi.h>
#include <esp_wifi.h>
#ifdef JC3248W535
#include <SD_MMC.h>
// Wrapper: use SD_MMC as "SDFS" so existing SDFS.open/SDFS.exists calls work
#define SDFS SD_MMC
#else
#include <SD.h>
#include <SPI.h>
#define SDFS SD
#endif
#include <MD5Builder.h>
#include <Preferences.h>
#include <atomic>

// ── Globals defined here ────────────────────────────────────────────────────

WiFiUDP dnsUdp;
#ifdef JC3248W535
AsyncWebServer httpServer(80);
#else
WebServer httpServer(80);
#endif

// ── DNS response IP ─────────────────────────────────────────────────────────

static IPAddress dnsResponseIP;
static File mowerFwFileHandle;

// ── External Preferences (owned by main.cpp) ────────────────────────────────

extern Preferences prefs;

// ── WebServer Client Accessor ───────────────────────────────────────────────
// Exposes the protected _currentClient member from WebServer
#ifndef JC3248W535
class WebServerExt : public WebServer {
public:
    WebServerExt(int port) : WebServer(port) {}
    bool isClientConnected() { return _currentClient.connected(); }
};

#define EXT_SERVER(s) (static_cast<WebServerExt*>(&s))
#endif

// ── Hardware Control Macros ─────────────────────────────────────────────────
#ifdef WAVESHARE_LCD
#define DEACTIVATE_LCD() digitalWrite(LCD_CS, HIGH)
#define REACTIVATE_LCD() digitalWrite(LCD_CS, LOW)
#else
#define DEACTIVATE_LCD()
#define REACTIVATE_LCD()
#endif

// ── WiFi AP ──────────────────────────────────────────────────────────────────

void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
    switch (event) {
        case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
            {
                char staMac[18];
                snprintf(staMac, sizeof(staMac), "%02X:%02X:%02X:%02X:%02X:%02X",
                    info.wifi_ap_staconnected.mac[0], info.wifi_ap_staconnected.mac[1],
                    info.wifi_ap_staconnected.mac[2], info.wifi_ap_staconnected.mac[3],
                    info.wifi_ap_staconnected.mac[4], info.wifi_ap_staconnected.mac[5]);
                const char* who = "unknown";
                String staMacStr = String(staMac);
                // 1. Try matching against BLE scan results
                for (int si = 0; si < scanResultCount; si++) {
                    if (scanResults[si].isCharger || scanResults[si].isMower) {
                        String bleMac = scanResults[si].mac;
                        bleMac.toUpperCase();
                        // Mower: WiFi MAC = BLE MAC
                        if (staMacStr.equalsIgnoreCase(bleMac)) {
                            who = scanResults[si].isMower ? "MOWER" : "CHARGER";
                        }
                        // Charger: WiFi STA MAC = BLE MAC - 2
                        if (scanResults[si].isCharger && bleMac.length() >= 17) {
                            int lastByte = strtol(bleMac.substring(15).c_str(), NULL, 16) - 2;
                            char expected[18];
                            snprintf(expected, sizeof(expected), "%s%02X",
                                bleMac.substring(0, 15).c_str(), lastByte & 0xFF);
                            if (staMacStr.equalsIgnoreCase(String(expected))) {
                                who = "CHARGER";
                            }
                        }
                    }
                }
                // 2. Fallback: identify by MAC prefix
                if (strcmp(who, "unknown") == 0) {
                    if (staMacStr.startsWith("48:27")) who = "CHARGER";
                    else if (staMacStr.startsWith("70:4A") || staMacStr.startsWith("50:41")) who = "MOWER";
                }
                // Set WiFi-detected flags
                if (strcmp(who, "CHARGER") == 0) chargerWifiDetected = true;
                if (strcmp(who, "MOWER") == 0) mowerWifiDetected = true;
                Serial.printf("[WiFi] Station connected: %s (%s)\r\n", staMac, who);
                webLogAdd("WiFi: %s connected (%s)", who, staMac);
                // Check DHCP IP after a short delay (log in next loop iteration)
                // For immediate check: query the sta list
                wifi_sta_list_t sl;
                esp_wifi_ap_get_sta_list(&sl);
                for (int s = 0; s < sl.num; s++) {
                    // Log MAC only — IP lookup varies by ESP-IDF version
                    Serial.printf("[WiFi]   STA %02X:%02X:%02X:%02X:%02X:%02X\r\n",
                        sl.sta[s].mac[0], sl.sta[s].mac[1], sl.sta[s].mac[2],
                        sl.sta[s].mac[3], sl.sta[s].mac[4], sl.sta[s].mac[5]);
                }
            }
            break;
        case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
            Serial.printf("[WiFi] Station disconnected: %02x:%02x:%02x:%02x:%02x:%02x\r\n",
                info.wifi_ap_stadisconnected.mac[0], info.wifi_ap_stadisconnected.mac[1],
                info.wifi_ap_stadisconnected.mac[2], info.wifi_ap_stadisconnected.mac[3],
                info.wifi_ap_stadisconnected.mac[4], info.wifi_ap_stadisconnected.mac[5]);
            break;
        default:
            break;
    }
}

void setupWifiAP() {
    WiFi.onEvent(onWifiEvent);
    // Use AP+STA mode from the beginning so scanning later doesn't disrupt the AP
    WiFi.mode(WIFI_AP_STA);
    // Configure DHCP BEFORE starting AP -- charger connects instantly and needs DHCP ready
    esp_netif_t* apNetif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (apNetif) {
        // DHCP server is auto-started by softAP, stop it first to configure
        esp_netif_dhcps_stop(apNetif);

        // 1. Set our AP IP as the DNS server for the network interface
        esp_netif_dns_info_t dnsInfo;
        dnsInfo.ip.u_addr.ip4.addr = ipaddr_addr("10.0.0.1");
        dnsInfo.ip.type = ESP_IPADDR_TYPE_V4;
        esp_netif_set_dns_info(apNetif, ESP_NETIF_DNS_MAIN, &dnsInfo);

        // 2. Enable DHCP DNS offer so clients receive our DNS via DHCP option 6
        uint8_t offer = 1; // ESP-IDF v5 requires uint8_t for offer types rather than dhcps_offer_t, 1 = true
        esp_netif_dhcps_option(apNetif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offer, sizeof(offer));
        Serial.printf("[WiFi] DHCP pre-configured with DNS=10.0.0.1\r\n");
        // DON'T restart DHCP yet -- softAP() will start it
    }

    // Use 10.0.0.x subnet -- NOT 192.168.4.x which conflicts with charger's own AP!
    // The charger runs AP+STA mode with its AP on 192.168.4.1 -> subnet clash breaks DHCP.
    WiFi.softAPConfig(IPAddress(10,0,0,1), IPAddress(10,0,0,1), IPAddress(255,255,255,0));
    WiFi.softAP(AP_SSID, AP_PASSWORD, 6, 0, 4);  // channel 6 (less crowded), not hidden, max 4

    // Set WPA/WPA2 mixed auth mode for ESP32 charger compatibility
    wifi_config_t conf;
    esp_wifi_get_config(WIFI_IF_AP, &conf);
    conf.ap.authmode = WIFI_AUTH_WPA_WPA2_PSK;
    esp_wifi_set_config(WIFI_IF_AP, &conf);

    // WiFi stability — HT20 is more stable than HT40 for long transfers
    esp_wifi_set_ps(WIFI_PS_NONE);           // Disable power save (keeps AP responsive)
    esp_wifi_set_max_tx_power(84);           // Max TX power: 21dBm
    esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);  // 20MHz = more stable, less interference
    esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);

    // Now start DHCP server (after AP is active)
    if (apNetif) {
        esp_err_t err = esp_netif_dhcps_start(apNetif);
        Serial.printf("[WiFi] DHCP server started (err=%d)\r\n", err);
    }

    delay(500);
    Serial.printf("[WiFi] AP started: %s (IP: %s, ch=%d)\r\n", AP_SSID,
                  WiFi.softAPIP().toString().c_str(), WiFi.channel());
}

// ── DNS -- resolve mqtt.lfibot.com -> our AP IP ──────────────────────────────

void setupDNS() {
    dnsResponseIP = WiFi.softAPIP();
    dnsUdp.begin(53);
    Serial.printf("[DNS] Custom DNS started on port 53 — all queries -> %s\r\n", dnsResponseIP.toString().c_str());
    webLogAdd("DNS: all queries -> %s", dnsResponseIP.toString().c_str());
}

void processDNS() {
    int packetSize = dnsUdp.parsePacket();
    if (packetSize < 12) return;  // Too small for DNS header

    uint8_t buf[512];
    int len = dnsUdp.read(buf, sizeof(buf));
    if (len < 12) return;

    // Extract query name for logging
    char queryName[128] = {0};
    int qpos = 12;  // DNS header is 12 bytes
    int npos = 0;
    while (qpos < len && buf[qpos] != 0 && npos < 126) {
        int labelLen = buf[qpos++];
        if (npos > 0) queryName[npos++] = '.';
        for (int j = 0; j < labelLen && qpos < len && npos < 126; j++) {
            queryName[npos++] = buf[qpos++];
        }
    }
    queryName[npos] = 0;
    qpos++;  // skip null terminator
    qpos += 4;  // skip QTYPE (2) + QCLASS (2)

    // Log DNS queries (suppress during OTA to reduce serial overhead)
    if (!(mowerOtaTriedPlain || mowerOtaTriedAes)) {
        Serial.printf("[DNS] %s → %s (from %s)\r\n", queryName, dnsResponseIP.toString().c_str(), dnsUdp.remoteIP().toString().c_str());
        if (strstr(queryName, "lfibot") || strstr(queryName, "mqtt")) {
            webLogAdd("DNS: %s → %s", queryName, dnsResponseIP.toString().c_str());
        }
    }

    // Build response: copy header, set response flags, append answer
    uint8_t resp[512];
    memcpy(resp, buf, len);  // Copy entire query

    // Set response flags: QR=1, AA=1, RD=1, RA=1
    resp[2] = 0x85;  // QR=1, Opcode=0, AA=1, TC=0, RD=1
    resp[3] = 0x80;  // RA=1, Z=0, RCODE=0 (no error)

    // Set answer count = 1
    resp[6] = 0x00;
    resp[7] = 0x01;

    // Append answer: name pointer + type A + class IN + TTL + data length + IP
    int rpos = len;  // Start after the query
    // Name pointer to offset 12 (the query name)
    resp[rpos++] = 0xC0;
    resp[rpos++] = 0x0C;
    // Type A (1)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x01;
    // Class IN (1)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x01;
    // TTL (60 seconds)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x3C;
    // Data length (4 bytes for IPv4)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x04;
    // IP address
    resp[rpos++] = dnsResponseIP[0];
    resp[rpos++] = dnsResponseIP[1];
    resp[rpos++] = dnsResponseIP[2];
    resp[rpos++] = dnsResponseIP[3];

    dnsUdp.beginPacket(dnsUdp.remoteIP(), dnsUdp.remotePort());
    dnsUdp.write(resp, rpos);
    dnsUdp.endPacket();
}

// ── Charger WiFi control for OTA ────────────────────────────────────────────


#ifndef JC3248W535
void streamFileWithYield(WebServer& server, File& file, const String& contentType) {
    server.setContentLength(file.size());
    server.send(200, contentType, "");

    uint8_t buf[2048];
    while (file.available() && EXT_SERVER(server)->isClientConnected()) {
        size_t len = file.read(buf, sizeof(buf));
        if (len > 0) {
            server.sendContent((const char*)buf, len);
        }

        // Pump the other services so they don't time out during large file streaming
        mqttBroker.update();
        processDNS();
        yield();
    }
}
#endif

// ── HTTP server -- serves firmware + status ──────────────────────────────────

void setupHTTP() {
    // ── Main status/config page ──────────────────────────────────────────────
#ifdef JC3248W535
    httpServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
#else
    httpServer.on("/", []() {
#endif
        String html = R"rawhtml(<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova-OTA</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#1a1a2e;color:#e0e0e0;padding:16px;min-height:100vh}
  .container{max-width:480px;margin:0 auto}
  h1{color:#00d4aa;font-size:24px;margin-bottom:4px}
  .version{color:#666;font-size:12px;margin-bottom:20px}
  .card{background:#16213e;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #0f3460}
  .card h2{font-size:16px;color:#7c3aed;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-size:14px}
  .value{font-size:14px;font-weight:600}
  .on{color:#00d4aa}
  .off{color:#ef4444}
  .sn{color:#a78bfa;font-family:monospace;font-size:13px}
  label{display:block;color:#888;font-size:13px;margin-bottom:4px;margin-top:12px}
  label:first-child{margin-top:0}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;background:#0d0d20;border:2px solid #333;border-radius:8px;color:#fff;font-size:15px}
  input:focus{border-color:#7c3aed;outline:none}
  .btn{display:block;width:100%;padding:12px;margin-top:16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;text-align:center}
  .btn:active{background:#6d28d9}
  .btn:disabled{background:#444;cursor:not-allowed}
  .msg{text-align:center;padding:8px;border-radius:8px;margin-top:12px;font-size:14px;display:none}
  .msg.ok{display:block;background:rgba(0,212,170,.15);color:#00d4aa}
  .msg.err{display:block;background:rgba(239,68,68,.15);color:#ef4444}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot.on{background:#00d4aa}
  .dot.off{background:#ef4444}
  .toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:6px;cursor:pointer}
  .toggle input{width:auto;margin:0}
</style>
</head><body>
<div class="container">
  <h1>Nova-OTA Device</h1>
  <div class="version">)rawhtml" + String(VERSION) + R"rawhtml(</div>

  <!-- Status section (auto-refreshed) -->
  <div class="card">
    <h2>Status</h2>
    <div class="row"><span class="label">WiFi AP</span><span class="value" id="ap">--</span></div>
    <div class="row"><span class="label">Connected clients</span><span class="value" id="clients">--</span></div>
    <div id="clientList" style="margin:4px 0 8px 0;font-size:12px;color:#aaa"></div>
    <div class="row"><span class="label">State</span><span class="value" id="state">--</span></div>
    <div class="row"><span class="label">Status</span><span class="value" id="msg">--</span></div>
  </div>

  <!-- Console log -->
  <div class="card">
    <h2>Console</h2>
    <div id="console" style="background:#0a0a1a;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;color:#aaa;max-height:200px;overflow-y:auto;white-space:pre-wrap"></div>
  </div>

  <div class="card">
    <h2>Charger</h2>
    <div class="row"><span class="label">WiFi</span><span class="value" id="chWifi">--</span></div>
    <div class="row"><span class="label">MQTT</span><span class="value" id="chMqtt">--</span></div>
    <div class="row"><span class="label">Serial</span><span class="value sn" id="chSn">--</span></div>
  </div>

  <div class="card">
    <h2>Mower</h2>
    <div class="row"><span class="label">WiFi</span><span class="value" id="mwWifi">--</span></div>
    <div class="row"><span class="label">MQTT</span><span class="value" id="mwMqtt">--</span></div>
    <div class="row"><span class="label">Serial</span><span class="value sn" id="mwSn">--</span></div>
  </div>

  <div class="card">
    <h2>Firmware</h2>
    <div class="row"><span class="label">File</span><span class="value" id="fwFile">--</span></div>
    <div class="row"><span class="label">Version</span><span class="value" id="fwVer">--</span></div>
    <div class="row"><span class="label">BLE devices found</span><span class="value" id="bleCnt">--</span></div>
  </div>

  <!-- SD Card file manager -->
  <div class="card">
    <h2>SD Card</h2>
    <div id="sdFiles">Loading...</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)">
      <form id="uploadForm" onsubmit="return doUpload(event)">
        <input type="file" id="fwFile2" accept=".deb,.bin" style="font-size:13px;color:#aaa">
        <button class="btn" type="submit" id="uploadBtn" style="margin-top:8px">Upload to SD</button>
      </form>
      <div id="uploadProgress" style="display:none;margin-top:8px">
        <div style="background:#0a0a1a;border-radius:4px;height:20px;overflow:hidden">
          <div id="progBar" style="height:100%;background:#7c3aed;width:0%;transition:width 0.3s"></div>
        </div>
        <div id="progText" style="font-size:12px;color:#888;margin-top:4px">0%</div>
      </div>
      <div class="msg" id="uploadMsg"></div>
    </div>
  </div>

  <!-- WiFi config section -->
  <div class="card">
    <h2>Home WiFi Config</h2>
    <form id="wifiForm" onsubmit="return saveWifi(event)">
      <label for="ssid">SSID</label>
      <input type="text" id="ssid" name="ssid" placeholder="Home network name" autocomplete="off">
      <label for="pass">Password</label>
      <input type="password" id="pass" name="password" placeholder="WiFi password">
      <label class="toggle"><input type="checkbox" onclick="document.getElementById('pass').type=this.checked?'text':'password'"> Show password</label>
      <label for="mqtt">MQTT Server (IP address)</label>
      <input type="text" id="mqtt" name="mqtt_addr" placeholder="e.g. 192.168.0.177">
      <button class="btn" type="submit">Save</button>
    </form>
    <div class="msg" id="wifiMsg"></div>
  </div>
</div>

<script>
function dot(on){return '<span class="dot '+(on?'on':'off')+'"></span>'+(on?'Yes':'No')}
function upd(){
  fetch('/api/status').then(r=>r.json()).then(d=>{
    document.getElementById('ap').textContent=d.apSsid;
    document.getElementById('clients').textContent=d.apClients;
    var cl=document.getElementById('clientList');
    if(d.clients&&d.clients.length){cl.innerHTML=d.clients.map(c=>'<div>'+c.name+' <span style="color:#666">'+c.mac+'</span></div>').join('')}else{cl.innerHTML=''}
    document.getElementById('state').textContent=d.stateName;
    document.getElementById('msg').textContent=d.message;
    var con=document.getElementById('console');
    if(d.log&&d.log.length){con.textContent=d.log.join('\n');con.scrollTop=con.scrollHeight}
    document.getElementById('chWifi').innerHTML=dot(d.chargerWifi);
    document.getElementById('chMqtt').innerHTML=dot(d.chargerMqtt);
    document.getElementById('chSn').textContent=d.chargerSn||'--';
    document.getElementById('mwWifi').innerHTML=dot(d.mowerWifi);
    document.getElementById('mwMqtt').innerHTML=dot(d.mowerMqtt);
    document.getElementById('mwSn').textContent=d.mowerSn||'--';
    document.getElementById('fwFile').textContent=d.firmwareFile||'none';
    document.getElementById('fwVer').textContent=d.firmwareVersion||'--';
    document.getElementById('bleCnt').textContent=d.bleDevices;
    if(d.userSsid){document.getElementById('ssid').placeholder=d.userSsid+' (current)'}
    if(d.mqttAddr){document.getElementById('mqtt').placeholder=d.mqttAddr+' (current)'}
  }).catch(()=>{})
}
upd();setInterval(upd,3000);

function loadFiles(){
  fetch('/api/sd-files').then(r=>r.json()).then(d=>{
    var el=document.getElementById('sdFiles');
    if(!d.mounted){el.innerHTML='<span style="color:#ef4444">SD card not mounted</span>';return}
    if(!d.files||d.files.length===0){el.innerHTML='<span style="color:#888">No files on SD card</span>';return}
    el.innerHTML=d.files.map(f=>
      '<div class="row"><span class="label">'+f.name+'</span><span class="value" style="display:flex;gap:8px;align-items:center">'
      +'<span style="color:#888;font-size:12px">'+formatSize(f.size)+'</span>'
      +'<span style="color:#ef4444;cursor:pointer;font-size:12px" onclick="delFile(\''+f.name+'\')">[x]</span>'
      +'</span></div>'
    ).join('');
  }).catch(()=>{document.getElementById('sdFiles').innerHTML='<span style="color:#ef4444">Error</span>'})
}
function formatSize(b){if(b>1048576)return (b/1048576).toFixed(1)+'MB';if(b>1024)return (b/1024).toFixed(0)+'KB';return b+'B'}
function delFile(name){
  if(!confirm('Delete '+name+'?'))return;
  fetch('/api/sd-delete?name='+encodeURIComponent(name),{method:'DELETE'}).then(r=>r.json()).then(d=>{
    if(d.ok)loadFiles(); else alert(d.error||'Delete failed');
  })
}
loadFiles();

function doUpload(e){
  e.preventDefault();
  var f=document.getElementById('fwFile2').files[0];
  if(!f){alert('Select a file first');return false}
  var xhr=new XMLHttpRequest();
  var prog=document.getElementById('uploadProgress');
  var bar=document.getElementById('progBar');
  var txt=document.getElementById('progText');
  var msg=document.getElementById('uploadMsg');
  var btn=document.getElementById('uploadBtn');
  prog.style.display='block';msg.className='msg';btn.disabled=true;
  xhr.upload.onprogress=function(e){
    if(e.lengthComputable){var pct=Math.round(e.loaded/e.total*100);bar.style.width=pct+'%';txt.textContent=pct+'% ('+formatSize(e.loaded)+' / '+formatSize(e.total)+')'}
  };
  xhr.onload=function(){
    btn.disabled=false;
    if(xhr.status===200){msg.className='msg ok';msg.textContent='Upload complete!';loadFiles()}
    else{msg.className='msg err';msg.textContent='Upload failed: '+xhr.statusText}
  };
  xhr.onerror=function(){btn.disabled=false;msg.className='msg err';msg.textContent='Connection error'};
  var fd=new FormData();fd.append('firmware',f);
  xhr.open('POST','/upload');xhr.send(fd);
  return false;
}

function saveWifi(e){
  e.preventDefault();
  var s=document.getElementById('ssid').value;
  var p=document.getElementById('pass').value;
  var q=document.getElementById('mqtt').value;
  var m=document.getElementById('wifiMsg');
  if(!s){m.className='msg err';m.textContent='SSID is required';return false}
  fetch('/api/wifi-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:s,password:p,mqtt_addr:q})})
  .then(r=>r.json()).then(d=>{
    if(d.success){m.className='msg ok';m.textContent='Saved! Devices will be re-provisioned.'}
    else{m.className='msg err';m.textContent=d.error||'Failed'}
  }).catch(()=>{m.className='msg err';m.textContent='Connection error'});
  return false;
}
</script>
</body></html>)rawhtml";
#ifdef JC3248W535
        request->send(200, "text/html", html);
#else
        httpServer.send(200, "text/html", html);
#endif
    });

    // ── JSON status API ──────────────────────────────────────────────────────
#ifdef JC3248W535
    httpServer.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *request) {
#else
    httpServer.on("/api/status", HTTP_GET, []() {
#endif
        // Determine charger SN from topic
        String chargerSnStr = "";
        if (chargerTopic.startsWith("Dart/Send_mqtt/")) {
            chargerSnStr = chargerTopic.substring(15);
        }

        // Charger WiFi: we know it's connected if we got an MQTT connection from it
        bool chargerWifi = chargerMqttConnected;
        // Mower WiFi: at least one STA connected and mower MQTT is up
        bool mowerWifi = mowerConnected;

        // State name for display
        const char* stateNames[] = {
            "Boot",
            "Scan Charger", "Provision Charger", "Wait Charger",
            "Scan Mower", "Provision Mower", "Wait Mower",
            "OTA Flash", "Re-provision",
            "Done", "Error"
        };
        const char* stateName = (currentState >= 0 && currentState <= WIZ_ERROR)
            ? stateNames[currentState] : "Unknown";

        // WiFi client list with MAC + IP
        wifi_sta_list_t staList;
        esp_wifi_ap_get_sta_list(&staList);
        String clientsJson = "[";
        for (int i = 0; i < staList.num; i++) {
            if (i > 0) clientsJson += ",";
            char mac[18];
            snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                staList.sta[i].mac[0], staList.sta[i].mac[1], staList.sta[i].mac[2],
                staList.sta[i].mac[3], staList.sta[i].mac[4], staList.sta[i].mac[5]);
            // Identify device by MAC
            const char* who = "unknown";
            String macStr = String(mac);

            // 1. Check against BLE scan results (if available)
            for (int s = 0; s < scanResultCount; s++) {
                if (scanResults[s].isCharger) {
                    String bleMac = scanResults[s].mac;
                    bleMac.toUpperCase();
                    if (bleMac.length() >= 17) {
                        int lastByte = strtol(bleMac.substring(15).c_str(), NULL, 16) - 2;
                        char expected[18];
                        snprintf(expected, sizeof(expected), "%s%02X",
                            bleMac.substring(0, 15).c_str(), lastByte & 0xFF);
                        if (macStr.equalsIgnoreCase(String(expected))) who = "Charger";
                    }
                }
                if (scanResults[s].isMower && macStr.equalsIgnoreCase(scanResults[s].mac)) {
                    who = "Mower";
                }
            }

            // 2. Heuristic: Espressif OUI (48:27:E2, 30:C6:F7, etc.) = likely charger
            if (strcmp(who, "unknown") == 0) {
                if (macStr.startsWith("48:27:E2") || macStr.startsWith("30:C6:F7") ||
                    macStr.startsWith("EC:DA:3B") || macStr.startsWith("24:0A:C4")) {
                    who = "Charger (likely)";
                }
                // Mower: Horizon Robotics OUI 70:4A:0E
                else if (macStr.startsWith("70:4A:0E")) {
                    who = "Mower (likely)";
                }
            }

            clientsJson += "{\"mac\":\"" + macStr + "\",\"name\":\"" + String(who) + "\"}";
        }
        clientsJson += "]";

        // Log ring buffer
        String logJson = "[";
        for (int i = 0; i < webLogCount; i++) {
            int idx = (webLogHead - webLogCount + i + WEB_LOG_SIZE) % WEB_LOG_SIZE;
            if (i > 0) logJson += ",";
            // Escape quotes in log lines
            String line = webLog[idx];
            line.replace("\"", "'");
            logJson += "\"" + line + "\"";
        }
        logJson += "]";

        String json = "{";
        json += "\"apSsid\":\"" + String(AP_SSID) + "\",";
        json += "\"apClients\":" + String(WiFi.softAPgetStationNum()) + ",";
        json += "\"clients\":" + clientsJson + ",";
        json += "\"state\":" + String(currentState) + ",";
        json += "\"stateName\":\"" + String(stateName) + "\",";
        json += "\"message\":\"" + statusMessage + "\",";
        json += "\"chargerWifi\":" + String(chargerWifi ? "true" : "false") + ",";
        json += "\"chargerMqtt\":" + String(chargerMqttConnected ? "true" : "false") + ",";
        json += "\"chargerSn\":\"" + chargerSnStr + "\",";
        json += "\"mowerWifi\":" + String(mowerWifi ? "true" : "false") + ",";
        json += "\"mowerMqtt\":" + String(mowerConnected ? "true" : "false") + ",";
        json += "\"mowerSn\":\"" + mowerSn + "\",";
        json += "\"firmwareFile\":\"" + firmwareFilename + "\",";
        json += "\"firmwareVersion\":\"" + firmwareVersion + "\",";
        json += "\"firmwareSize\":" + String(firmwareSize) + ",";
        json += "\"bleDevices\":" + String(scanResultCount) + ",";
        json += "\"userSsid\":\"" + userWifiSsid + "\",";
        json += "\"mqttAddr\":\"" + userMqttAddr + "\",";
        json += "\"log\":" + logJson;
        json += "}";
#ifdef JC3248W535
        request->send(200, "application/json", json);
#else
        httpServer.send(200, "application/json", json);
#endif
    });

    // ── WiFi config API ──────────────────────────────────────────────────────
#ifdef JC3248W535
    httpServer.on("/api/wifi-config", HTTP_POST, [](AsyncWebServerRequest *request) {
        String body = request->arg("plain");
#else
    httpServer.on("/api/wifi-config", HTTP_POST, []() {
        String body = httpServer.arg("plain");
#endif
        // Simple JSON parsing (no ArduinoJson dependency)
        String ssid = "";
        String password = "";

        int ssidIdx = body.indexOf("\"ssid\"");
        if (ssidIdx >= 0) {
            int colonIdx = body.indexOf(':', ssidIdx);
            int startQuote = body.indexOf('"', colonIdx + 1);
            int endQuote = body.indexOf('"', startQuote + 1);
            if (startQuote >= 0 && endQuote > startQuote) {
                ssid = body.substring(startQuote + 1, endQuote);
            }
        }

        int passIdx = body.indexOf("\"password\"");
        if (passIdx >= 0) {
            int colonIdx = body.indexOf(':', passIdx);
            int startQuote = body.indexOf('"', colonIdx + 1);
            int endQuote = body.indexOf('"', startQuote + 1);
            if (startQuote >= 0 && endQuote > startQuote) {
                password = body.substring(startQuote + 1, endQuote);
            }
        }

        String mqttAddr = "";
        int mqttIdx = body.indexOf("\"mqtt_addr\"");
        if (mqttIdx >= 0) {
            int colonIdx = body.indexOf(':', mqttIdx);
            int startQuote = body.indexOf('"', colonIdx + 1);
            int endQuote = body.indexOf('"', startQuote + 1);
            if (startQuote >= 0 && endQuote > startQuote) {
                mqttAddr = body.substring(startQuote + 1, endQuote);
            }
        }

        if (ssid.length() == 0) {
#ifdef JC3248W535
            request->send(400, "application/json", "{\"success\":false,\"error\":\"SSID is required\"}");
#else
            httpServer.send(400, "application/json", "{\"success\":false,\"error\":\"SSID is required\"}");
#endif
            return;
        }

        userWifiSsid = ssid;
        userWifiPassword = password;
        // Also update the ui_ buffers so the display/Phase 2 flow picks them up
        strncpy(ui_wifiSsid, ssid.c_str(), sizeof(ui_wifiSsid) - 1);
        ui_wifiSsid[sizeof(ui_wifiSsid) - 1] = '\0';
        strncpy(ui_wifiPassword, password.c_str(), sizeof(ui_wifiPassword) - 1);
        ui_wifiPassword[sizeof(ui_wifiPassword) - 1] = '\0';

        // Save MQTT address if provided
        if (mqttAddr.length() > 0) {
            userMqttAddr = mqttAddr;
            prefs.putString("mqtt_addr", mqttAddr);
        }

        // Persist to NVS so it survives reboot
        prefs.putString("wifi_ssid", ssid);
        prefs.putString("wifi_pass", password);

        Serial.printf("[HTTP] Config saved to NVS: SSID='%s' MQTT='%s'\r\n",
                      ssid.c_str(), userMqttAddr.c_str());
#ifdef JC3248W535
        request->send(200, "application/json", "{\"success\":true}");
#else
        httpServer.send(200, "application/json", "{\"success\":true}");
#endif
    });

    // Firmware download -- mower .deb
    // Uses AsyncWebServer's built-in static file serving which handles:
    // - Chunking with proper LwIP thread yielding (no vTaskDelay blocking)
    // - HTTP Range requests (206 Partial Content) for download resume
    // - Automatic memory management and file closing
    static std::atomic<bool> isFirmwareDownloading(false);
    static File currentDownloadFile;
#ifdef JC3248W535
    httpServer.on("/firmware.deb", HTTP_GET, [](AsyncWebServerRequest *request) {
        // Concurrency lock — concurrent SD reads block CPU, WiFi beacons get missed
        if (isFirmwareDownloading) {
            request->send(429, "text/plain", "Download in progress");
            return;
        }

        String path = "/" + mowerFwFilename;
        if (mowerFwFilename.length() == 0 || !SDFS.exists(path)) {
            request->send(404, "text/plain", "No mower firmware");
            return;
        }

        currentDownloadFile = SDFS.open(path, FILE_READ);
        if (!currentDownloadFile) {
            request->send(500, "text/plain", "SD read error");
            return;
        }

        size_t fileSize = currentDownloadFile.size();
        size_t startByte = 0;
        size_t endByte = fileSize - 1;

        // Parse HTTP Range header (e.g. "bytes=7168000-")
        if (request->hasHeader("Range")) {
            String range = request->header("Range");
            if (range.startsWith("bytes=")) {
                int dashPos = range.indexOf('-');
                if (dashPos > 0) {
                    startByte = range.substring(6, dashPos).toInt();
                }
            }
        }

        if (startByte >= fileSize) {
            currentDownloadFile.close();
            request->send(416, "text/plain", "Range Not Satisfiable");
            return;
        }

        currentDownloadFile.seek(startByte);
        size_t contentLength = fileSize - startByte;

        AsyncWebServerResponse *response = request->beginResponse("application/octet-stream", contentLength,
            [contentLength](uint8_t *buffer, size_t maxLen, size_t index) -> size_t {
                if (!currentDownloadFile) return 0;
                size_t chunkSize = (maxLen > 2048) ? 2048 : maxLen;
                if (index + chunkSize > contentLength) {
                    chunkSize = contentLength - index;
                }
                size_t bytesRead = currentDownloadFile.read(buffer, chunkSize);
                if (index + bytesRead >= contentLength || bytesRead == 0) {
                    currentDownloadFile.close();
                }
                return bytesRead;
            });

        response->addHeader("Accept-Ranges", "bytes");

        if (startByte > 0) {
            response->setCode(206);
            String contentRange = "bytes " + String(startByte) + "-" + String(endByte) + "/" + String(fileSize);
            response->addHeader("Content-Range", contentRange);
            Serial.printf("[HTTP] Resume (206): %s\r\n", contentRange.c_str());
        } else {
            response->setCode(200);
            Serial.printf("[HTTP] Serving firmware: %u bytes\r\n", fileSize);
        }

        isFirmwareDownloading = true;

        request->onDisconnect([]() {
            isFirmwareDownloading = false;
            if (currentDownloadFile) {
                currentDownloadFile.close();
            }
            Serial.println("[HTTP] Download closed, lock released");
        });

        request->send(response);
    });
#else
    httpServer.on("/firmware.deb", []() {
        if (!mowerFwFileHandle || mowerFwFilename.length() == 0) {
            httpServer.send(404, "text/plain", "No mower firmware");
            return;
        }
        mowerFwFileHandle.seek(0);  // Rewind to start
        Serial.printf("[HTTP] Serving mower firmware: %s (%d bytes)\r\n",
            mowerFwFilename.c_str(), mowerFwFileHandle.size());
        DEACTIVATE_LCD();
        httpServer.setContentLength(mowerFwFileHandle.size());
        httpServer.send(200, "application/octet-stream", "");
        uint8_t buf[4096];
        while (mowerFwFileHandle.available()) {
            size_t len = mowerFwFileHandle.read(buf, sizeof(buf));
            if (len > 0) httpServer.sendContent((const char*)buf, len);
            mqttBroker.update();
            processDNS();
            yield();
        }
        REACTIVATE_LCD();
    });
#endif

    // Firmware download -- charger .bin
#ifdef JC3248W535
    httpServer.on("/charger.bin", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (chargerFwFilename.length() == 0) { request->send(404, "text/plain", "No charger firmware"); return; }
        File file = SDFS.open("/" + chargerFwFilename);
        if (!file) { request->send(404, "text/plain", "File not found"); return; }
        Serial.printf("[HTTP] Serving charger firmware: %s (%d bytes)\r\n", chargerFwFilename.c_str(), file.size());
        AsyncWebServerResponse *response = request->beginResponse("application/octet-stream", file.size(),
            [file](uint8_t *buffer, size_t maxLen, size_t index) mutable -> size_t {
                return file.read(buffer, maxLen);
            });
        request->send(response);
    });
#else
    httpServer.on("/charger.bin", []() {
        if (chargerFwFilename.length() == 0) { httpServer.send(404, "text/plain", "No charger firmware"); return; }
        File file = SDFS.open("/" + chargerFwFilename);
        if (!file) { httpServer.send(404, "text/plain", "File not found"); return; }
        Serial.printf("[HTTP] Serving charger firmware: %s (%d bytes)\r\n", chargerFwFilename.c_str(), file.size());
        streamFileWithYield(httpServer, file, "application/octet-stream");
        file.close();
    });
#endif

    // Status JSON
#ifdef JC3248W535
    httpServer.on("/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        String json = "{\"state\":\"" + String(currentState) + "\",";
        json += "\"message\":\"" + statusMessage + "\",";
        json += "\"firmware\":\"" + firmwareVersion + "\",";
        json += "\"mower\":\"" + (mowerConnected ? mowerSn : String("")) + "\"}";
        request->send(200, "application/json", json);
    });
#else
    httpServer.on("/status", []() {
        String json = "{\"state\":\"" + String(currentState) + "\",";
        json += "\"message\":\"" + statusMessage + "\",";
        json += "\"firmware\":\"" + firmwareVersion + "\",";
        json += "\"mower\":\"" + (mowerConnected ? mowerSn : String("")) + "\"}";
        httpServer.send(200, "application/json", json);
    });
#endif

    // Mower net_check_fun hits this URL to verify connectivity
#ifdef JC3248W535
    httpServer.on("/api/nova-network/network/connection", HTTP_POST, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json",
            "{\"success\":true,\"code\":200,\"message\":\"request success\",\"value\":1}");
    });
#else
    httpServer.on("/api/nova-network/network/connection", HTTP_POST, []() {
        httpServer.send(200, "application/json",
            "{\"success\":true,\"code\":200,\"message\":\"request success\",\"value\":1}");
    });
#endif

    // WiFi credential entry via phone browser (much easier than tiny on-screen keyboard)
#ifdef JC3248W535
    httpServer.on("/wifi", HTTP_GET, [](AsyncWebServerRequest *request) {
#else
    httpServer.on("/wifi", HTTP_GET, []() {
#endif
        String ssid = String(ui_wifiSsid);
        String html = R"rawhtml(
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova-OTA WiFi</title>
<style>
  body{font-family:system-ui;background:#0a0a1a;color:#e0e0e0;margin:0;padding:20px;display:flex;justify-content:center}
  .card{background:#1a1a2e;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  h1{color:#00d4aa;margin:0 0 8px;font-size:22px}
  .ssid{color:#888;margin-bottom:20px}
  label{display:block;margin-bottom:6px;font-size:14px;color:#aaa}
  input[type=password],input[type=text]{width:100%;padding:12px;border:2px solid #333;border-radius:8px;background:#0d0d20;color:#fff;font-size:16px;box-sizing:border-box;margin-bottom:16px}
  input:focus{border-color:#7c3aed;outline:none}
  button{width:100%;padding:14px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}
  button:active{background:#6d28d9}
  .toggle{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;color:#888;cursor:pointer}
  .toggle input{width:auto;margin:0}
</style></head><body>
<div class="card">
  <h1>WiFi Password</h1>
  <div class="ssid">Network: )rawhtml" + ssid + R"rawhtml(</div>
  <form method="POST" action="/wifi">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" placeholder="Enter WiFi password" autofocus>
    <label class="toggle"><input type="checkbox" onclick="document.getElementById('pw').type=this.checked?'text':'password'"> Show password</label>
    <button type="submit">Connect</button>
  </form>
</div></body></html>)rawhtml";
#ifdef JC3248W535
        request->send(200, "text/html", html);
#else
        httpServer.send(200, "text/html", html);
#endif
    });

#ifdef JC3248W535
    httpServer.on("/wifi", HTTP_POST, [](AsyncWebServerRequest *request) {
        if (request->hasArg("password")) {
            String pw = request->arg("password");
#else
    httpServer.on("/wifi", HTTP_POST, []() {
        if (httpServer.hasArg("password")) {
            String pw = httpServer.arg("password");
#endif
            strncpy(ui_wifiPassword, pw.c_str(), sizeof(ui_wifiPassword) - 1);
            ui_wifiPassword[sizeof(ui_wifiPassword) - 1] = '\0';
            ui_wifiPasswordReady = true;
            Serial.printf("[HTTP] WiFi password received via web (%d chars)\r\n", pw.length());
#ifdef JC3248W535
            request->send(200, "text/html",
                R"(<html><body style="font-family:system-ui;background:#0a0a1a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">)"
                R"(<div style="text-align:center"><h1 style="color:#00d4aa">&#10004; Credentials Received</h1>)"
                R"(<p>Check the device screen for progress.</p></div></body></html>)");
        } else {
            request->send(400, "text/plain", "Missing password field");
        }
    });
#else
            httpServer.send(200, "text/html",
                R"(<html><body style="font-family:system-ui;background:#0a0a1a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">)"
                R"(<div style="text-align:center"><h1 style="color:#00d4aa">&#10004; Credentials Received</h1>)"
                R"(<p>Check the device screen for progress.</p></div></body></html>)");
        } else {
            httpServer.send(400, "text/plain", "Missing password field");
        }
    });
#endif

    // Captive portal detection + catch-all redirect to dashboard
    // ── SD card API endpoints ───────────────────────────────────────────

    // List files on SD card
#ifdef JC3248W535
    httpServer.on("/api/sd-files", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!sdMounted) {
            request->send(200, "application/json", "{\"mounted\":false,\"files\":[]}");
            return;
        }
        String json = "{\"mounted\":true,\"files\":[";
        File root = SDFS.open("/");
        bool first = true;
        while (File f = root.openNextFile()) {
            if (!f.isDirectory()) {
                if (!first) json += ",";
                json += "{\"name\":\"" + String(f.name()) + "\",\"size\":" + String(f.size()) + "}";
                first = false;
            }
            f.close();
        }
        root.close();
        json += "]}";
        request->send(200, "application/json", json);
    });
#else
    httpServer.on("/api/sd-files", HTTP_GET, []() {
        if (!sdMounted) {
            httpServer.send(200, "application/json", "{\"mounted\":false,\"files\":[]}");
            return;
        }
        DEACTIVATE_LCD();  // Deactivate LCD during SD access
        String json = "{\"mounted\":true,\"files\":[";
        File root = SDFS.open("/");
        bool first = true;
        while (File f = root.openNextFile()) {
            if (!f.isDirectory()) {
                if (!first) json += ",";
                json += "{\"name\":\"" + String(f.name()) + "\",\"size\":" + String(f.size()) + "}";
                first = false;
            }
            f.close();
        }
        root.close();
        json += "]}";
        httpServer.send(200, "application/json", json);
    });
#endif

    // Delete file from SD card
#ifdef JC3248W535
    httpServer.on("/api/sd-delete", HTTP_DELETE, [](AsyncWebServerRequest *request) {
        String name = request->arg("name");
        if (name.length() == 0) { request->send(400, "application/json", "{\"ok\":false,\"error\":\"name required\"}"); return; }
        String path = name.startsWith("/") ? name : "/" + name;
        if (SDFS.exists(path)) {
            SDFS.remove(path);
            Serial.printf("[SD] Deleted: %s\r\n", path.c_str());
            request->send(200, "application/json", "{\"ok\":true}");
        } else {
            request->send(404, "application/json", "{\"ok\":false,\"error\":\"file not found\"}");
        }
    });
#else
    httpServer.on("/api/sd-delete", HTTP_DELETE, []() {
        String name = httpServer.arg("name");
        if (name.length() == 0) { httpServer.send(400, "application/json", "{\"ok\":false,\"error\":\"name required\"}"); return; }
        String path = name.startsWith("/") ? name : "/" + name;
        DEACTIVATE_LCD();
        if (SDFS.exists(path)) {
            SDFS.remove(path);
            Serial.printf("[SD] Deleted: %s\r\n", path.c_str());
            httpServer.send(200, "application/json", "{\"ok\":true}");
        } else {
            httpServer.send(404, "application/json", "{\"ok\":false,\"error\":\"file not found\"}");
        }
    });
#endif

    // Upload file to SD card -- stream directly, no RAM buffering
    static File uploadFile;
#ifdef JC3248W535
    httpServer.on("/upload", HTTP_POST,
        [](AsyncWebServerRequest *request) {
            request->send(200, "application/json", "{\"ok\":true}");
        },
        [](AsyncWebServerRequest *request, const String& filename, size_t index, uint8_t *data, size_t len, bool final) {
            if (index == 0) {
                String path = "/" + filename;
                Serial.printf("[UPLOAD] Start: %s\r\n", path.c_str());
                if (SDFS.exists(path)) SDFS.remove(path);
                uploadFile = SDFS.open(path, FILE_WRITE);
                if (!uploadFile) Serial.println("[UPLOAD] ERROR: Could not open file");
            }
            if (uploadFile && len > 0) {
                uploadFile.write(data, len);
            }
            if (final) {
                if (uploadFile) {
                    uploadFile.close();
                    Serial.printf("[UPLOAD] Done: %s (%u bytes)\r\n", filename.c_str(), index + len);
                }
            }
        }
    );
#else
    httpServer.on("/upload", HTTP_POST,
        []() {
            httpServer.send(200, "application/json", "{\"ok\":true}");
        },
        []() {
            HTTPUpload& upload = httpServer.upload();
            if (upload.status == UPLOAD_FILE_START) {
                DEACTIVATE_LCD();  // Deactivate LCD during SD write
                String filename = "/" + upload.filename;
                Serial.printf("[UPLOAD] Start: %s\r\n", filename.c_str());
                if (SDFS.exists(filename)) SDFS.remove(filename);
                uploadFile = SDFS.open(filename, FILE_WRITE);
                if (!uploadFile) Serial.println("[UPLOAD] ERROR: Could not open file");
            } else if (upload.status == UPLOAD_FILE_WRITE) {
                if (uploadFile) {
                    uploadFile.write(upload.buf, upload.currentSize);
                    if (upload.totalSize > 0 && upload.totalSize % (1024*1024) < upload.currentSize) {
                        Serial.printf("[UPLOAD] %d MB received\r\n", (int)(upload.totalSize / (1024*1024)));
                    }
                }
            } else if (upload.status == UPLOAD_FILE_END) {
                if (uploadFile) {
                    uploadFile.close();
                    Serial.printf("[UPLOAD] Done: %s (%d bytes)\r\n", upload.filename.c_str(), upload.totalSize);
                }
            }
        }
    );
#endif

#ifdef JC3248W535
    httpServer.onNotFound([](AsyncWebServerRequest *request) {
        String uri = request->url();
        String host = request->host();
        // Log ALL unhandled requests -- helps debug charger connectivity checks
        Serial.printf("[HTTP] 404: %s (Host: %s)\r\n",
            uri.c_str(), host.c_str());
        webLogAdd("HTTP: %s %s", uri.c_str(), host.c_str());

        // Apple captive portal check
        if (uri.indexOf("hotspot-detect") >= 0 || uri.indexOf("captive") >= 0) {
            request->send(200, "text/html", "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
            return;
        }
        // Android captive portal check
        if (uri.indexOf("generate_204") >= 0) {
            request->send(204);
            return;
        }
        // Everything else -> send 200 OK (charger may need HTTP success to start MQTT)
        request->send(200, "text/plain", "OK");
    });
#else
    httpServer.onNotFound([]() {
        String uri = httpServer.uri();
        String host = httpServer.hostHeader();
        // Log ALL unhandled requests -- helps debug charger connectivity checks
        Serial.printf("[HTTP] 404: %s (Host: %s)\r\n",
            uri.c_str(), host.c_str());
        webLogAdd("HTTP: %s %s", uri.c_str(), host.c_str());

        // Apple captive portal check
        if (uri.indexOf("hotspot-detect") >= 0 || uri.indexOf("captive") >= 0) {
            httpServer.send(200, "text/html", "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
            return;
        }
        // Android captive portal check
        if (uri.indexOf("generate_204") >= 0) {
            httpServer.send(204);
            return;
        }
        // Everything else -> send 200 OK (charger may need HTTP success to start MQTT)
        httpServer.send(200, "text/plain", "OK");
    });
#endif

    httpServer.begin();
    Serial.println("[HTTP] Server started on port 80");

}

// ── Firmware info from SD card ───────────────────────────────────────────────

bool loadFirmwareInfo() {
    bool foundAny = false;
    DEACTIVATE_LCD();  // Deactivate LCD during SD access
    File root = SDFS.open("/");
    while (File f = root.openNextFile()) {
        String name = f.name();

        // Mower firmware: .deb file
        if (name.endsWith(".deb") && mowerFwFilename.length() == 0) {
            mowerFwFilename = name;
            mowerFwSize = f.size();
            int vIdx = name.indexOf('v');
            int debIdx = name.indexOf(".deb");
            if (vIdx >= 0 && debIdx > vIdx) mowerFwVersion = name.substring(vIdx, debIdx);
#ifndef JC3248W535
            // Waveshare sync server needs a persistent file handle
            mowerFwFileHandle = SDFS.open("/" + name, FILE_READ);
            if (mowerFwFileHandle) {
                Serial.printf("[SD] Firmware file opened: %s (%d bytes)\r\n", name.c_str(), mowerFwFileHandle.size());
            }
#else
            Serial.printf("[SD] Firmware file found: %s (%d bytes)\r\n", name.c_str(), (int)f.size());
#endif
            mowerFwMd5 = computeMd5(("/" + name).c_str());
            Serial.printf("[SD] Mower firmware: %s (%d bytes, %s)\r\n",
                          name.c_str(), mowerFwSize, mowerFwVersion.c_str());
            foundAny = true;
        }

        // Charger firmware: .bin file (not .elf)
        if (name.endsWith(".bin") && chargerFwFilename.length() == 0) {
            chargerFwFilename = name;
            chargerFwSize = f.size();
            int vIdx = name.indexOf('v');
            int binIdx = name.indexOf(".bin");
            if (vIdx >= 0 && binIdx > vIdx) chargerFwVersion = name.substring(vIdx, binIdx);
            chargerFwMd5 = computeMd5(("/" + name).c_str());
            Serial.printf("[SD] Charger firmware: %s (%d bytes, %s)\r\n",
                          name.c_str(), chargerFwSize, chargerFwVersion.c_str());
            foundAny = true;
        }

        // Check for metadata JSON (same name but .json extension)
        if (name.endsWith(".json")) {
            File jf = SDFS.open("/" + name);
            if (jf && jf.size() < 2048) {
                String json = jf.readString();
                jf.close();
                Serial.printf("[SD] Metadata: %s (%d bytes)\r\n", name.c_str(), json.length());
                // Store for later display -- simple key extraction
                // TODO: parse and show in firmware check screen
            }
        }

        f.close();
    }
    root.close();
    if (!foundAny) Serial.println("[SD] No firmware files found!");
    return foundAny;
}

String computeMd5(const char* path) {
    // Deactivate LCD CS during SD read
    DEACTIVATE_LCD();
    File f = SDFS.open(path);
    if (!f) return "";
    MD5Builder md5;
    md5.begin();
    uint8_t buf[4096];
    unsigned long start = millis();
    while (f.available()) {
        int n = f.read(buf, sizeof(buf));
        if (n <= 0) break;  // Read error -- don't hang
        md5.add(buf, n);
        if (millis() - start > 30000) {  // 30s timeout
            Serial.println("[SD] MD5 computation timeout!");
            f.close();
            return "";
        }
    }
    f.close();
    md5.calculate();
    Serial.printf("[SD] MD5 of %s: %s (%lums)\r\n", path, md5.toString().c_str(), millis() - start);
    return md5.toString();
}
