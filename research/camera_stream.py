#!/usr/bin/env python3
"""
Multi-camera MJPEG HTTP server voor Novabot maaier.

LAZY MODE: Per-camera ROS subscriber + hardware worden pas geactiveerd
bij het eerste HTTP request voor die camera, en weer gestopt na idle
timeout. CPU overhead ~0% voor inactieve camera's.

Ondersteunde camera's (via ?topic= parameter):
  front     -> Front RGB halve resolutie (CompressedImage, default)
  front_hd  -> Front RGB volle resolutie (CompressedImage)
  tof_gray  -> ToF grijswaarden (raw Image -> JPEG)
  tof_depth -> ToF dieptebeeld (raw Image -> JPEG)
  aruco     -> Front + ArUco marker overlay (raw Image -> JPEG)

Endpoints:
  /stream?topic=front   -> MJPEG stream (~10fps)
  /snapshot?topic=front -> Single JPEG frame
  /status               -> JSON status van alle camera's
  /                     -> Test pagina
"""

from typing import Optional, Dict, Any
import os
import signal
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

rclpy = None  # Wordt geinitialiseerd in main()

# Graceful shutdown bij SIGTERM (run_novabot.sh stop)
def _sigterm_handler(signum, frame):
    print("[CAMERA] SIGTERM ontvangen, afsluiten...", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, _sigterm_handler)

# Configuratie
HTTP_PORT = 8000
MAX_FPS = 10
IDLE_TIMEOUT = 300  # seconden zonder viewers -> camera hardware uit (5 min)

# Camera topic definities
CAMERAS = {
    'front': {
        'topic': '/camera/preposition/image_half/compressed',
        'msg_type': 'compressed',
        'start_service': '/camera/preposition/start_camera',
        'label': 'Front (half)',
    },
    'front_hd': {
        'topic': '/camera/preposition/image/compressed',
        'msg_type': 'compressed',
        'start_service': '/camera/preposition/start_camera',
        'label': 'Front HD',
    },
    'tof_gray': {
        'topic': '/camera/tof/gray_image',
        'msg_type': 'raw',
        'start_service': '/camera/tof/start_camera',
        'label': 'ToF Gray',
    },
    'tof_depth': {
        'topic': '/camera/tof/depth_image',
        'msg_type': 'raw',
        'start_service': '/camera/tof/start_camera',
        'label': 'ToF Depth',
    },
    'aruco': {
        'topic': '/aruco/front_image',
        'msg_type': 'raw',
        'start_service': None,  # altijd actief, geen service nodig
        'label': 'ArUco',
    },
}

DEFAULT_TOPIC = 'front'


class CameraManager:
    """Beheert een enkele camera topic met lazy activatie.

    Node + subscription worden NOOIT vernietigd na creatie (CycloneDDS
    Galactic bug). Bij idle timeout wordt alleen de camera hardware
    gestopt via de start_camera service.
    """

    def __init__(self, key: str, config: dict):
        self.key = key
        self.config = config
        self._lock = threading.Lock()
        self._active = False
        self._activating = False
        self._subscribed = False
        self._watchdog_thread = None

        # Frame data
        self.latest_frame = None  # type: Optional[bytes]
        self.frame_lock = threading.Lock()
        self.frame_count = 0

        # Viewer tracking
        self.active_viewers = 0
        self.last_viewer_time = 0.0

    def activate(self, node):
        """Activeer camera hardware + subscription. Idempotent, non-blocking."""
        with self._lock:
            if self._active or self._activating:
                return
            self._activating = True

        t = threading.Thread(target=self._do_activate, args=(node,), daemon=True)
        t.start()

    def _do_activate(self, node):
        """Interne activatie in eigen thread."""
        # Eerste keer: subscription aanmaken (wordt nooit verwijderd)
        if not self._subscribed:
            self._create_subscription(node)
            self._subscribed = True

        # Camera hardware activeren
        if self.config['start_service']:
            print(f"[CAMERA:{self.key}] Camera hardware activeren...", flush=True)
            self._call_start_camera(node)
        else:
            print(f"[CAMERA:{self.key}] Geen start service (altijd actief)", flush=True)

        with self._lock:
            self._active = True
            self._activating = False

        # Start watchdog
        if self._watchdog_thread is None or not self._watchdog_thread.is_alive():
            self._watchdog_thread = threading.Thread(target=self._watchdog, daemon=True)
            self._watchdog_thread.start()

        print(f"[CAMERA:{self.key}] Actief", flush=True)

    def _create_subscription(self, node):
        """Maak ROS2 subscription aan op de gedeelde node.

        Alle Novabot camera topics publishen met RELIABLE QoS.
        """
        from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy

        qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )

        if self.config['msg_type'] == 'compressed':
            from sensor_msgs.msg import CompressedImage
            node.create_subscription(CompressedImage, self.config['topic'],
                                     self._compressed_callback, qos)
        else:
            from sensor_msgs.msg import Image
            node.create_subscription(Image, self.config['topic'],
                                     self._raw_callback, qos)

        print(f"[CAMERA:{self.key}] Subscribed op {self.config['topic']} ({self.config['msg_type']})", flush=True)

    def deactivate(self, node):
        """Stop camera hardware. Subscription blijft intact."""
        with self._lock:
            if not self._active:
                return
            self._active = False

        print(f"[CAMERA:{self.key}] Camera hardware stoppen (idle)...", flush=True)

        if self.config['start_service'] and node:
            self._call_stop_camera(node)

        with self.frame_lock:
            self.latest_frame = None

        print(f"[CAMERA:{self.key}] Hardware gestopt (subscription blijft)", flush=True)

    @property
    def is_active(self):
        with self._lock:
            return self._active or self._activating

    def get_frame(self):
        with self.frame_lock:
            return self.latest_frame

    def viewer_start(self, node):
        """Registreer viewer, activeer indien nodig."""
        self.active_viewers += 1
        self.last_viewer_time = time.time()
        if not self.is_active:
            self.activate(node)

    def viewer_stop(self):
        """Deregistreer viewer."""
        self.active_viewers = max(0, self.active_viewers - 1)
        self.last_viewer_time = time.time()

    def _compressed_callback(self, msg):
        """CompressedImage callback — data is al JPEG."""
        data = bytes(msg.data)
        with self.frame_lock:
            self.latest_frame = data
            self.frame_count += 1
        if self.frame_count == 1 or self.frame_count % 300 == 0:
            print(f"[CAMERA:{self.key}] Frame #{self.frame_count}: {len(data)} bytes", flush=True)

    def _raw_callback(self, msg):
        """Raw Image callback — converteer naar JPEG."""
        try:
            import cv2
            import numpy as np

            # Decodeer raw image data
            if msg.encoding == 'mono8':
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width)
            elif msg.encoding in ('mono16', '16UC1'):
                raw = np.frombuffer(msg.data, dtype=np.uint16).reshape(msg.height, msg.width)
                img = cv2.normalize(raw, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                if 'depth' in self.key:
                    img = cv2.applyColorMap(img, cv2.COLORMAP_JET)
            elif msg.encoding in ('32FC1',):
                raw = np.frombuffer(msg.data, dtype=np.float32).reshape(msg.height, msg.width)
                # Clamp NaN/inf, normaliseer naar 0-255
                raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)
                img = cv2.normalize(raw, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                if 'depth' in self.key:
                    img = cv2.applyColorMap(img, cv2.COLORMAP_JET)
            elif msg.encoding in ('bgr8', 'rgb8'):
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, 3)
                if msg.encoding == 'rgb8':
                    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            elif msg.encoding == 'bgra8' or msg.encoding == 'rgba8':
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, 4)
                if msg.encoding == 'rgba8':
                    img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
                else:
                    img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
            else:
                # Fallback: probeer als 3-channel
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(msg.height, msg.width, -1)

            _, jpeg = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
            data = jpeg.tobytes()

            with self.frame_lock:
                self.latest_frame = data
                self.frame_count += 1

            if self.frame_count == 1 or self.frame_count % 300 == 0:
                print(f"[CAMERA:{self.key}] Frame #{self.frame_count}: {msg.encoding} {msg.width}x{msg.height} -> {len(data)} bytes JPEG", flush=True)
        except Exception as e:
            if self.frame_count == 0:
                print(f"[CAMERA:{self.key}] Raw conversie fout: {e}", flush=True)

    def _call_start_camera(self, node):
        """Activeer camera hardware via ROS service + subprocess fallback."""
        service_path = self.config['start_service']
        if not service_path:
            return

        success = False
        try:
            from std_srvs.srv import SetBool
            client = node.create_client(SetBool, service_path)
            if client.wait_for_service(timeout_sec=5.0):
                req = SetBool.Request()
                req.data = True
                future = client.call_async(req)
                deadline = time.time() + 5.0
                while not future.done() and time.time() < deadline:
                    time.sleep(0.1)
                if future.done() and future.result() is not None:
                    print(f"[CAMERA:{self.key}] start_camera (rclpy): success={future.result().success}", flush=True)
                    success = True
                else:
                    print(f"[CAMERA:{self.key}] start_camera (rclpy): timeout", flush=True)
            else:
                print(f"[CAMERA:{self.key}] start_camera service niet beschikbaar", flush=True)
        except Exception as e:
            print(f"[CAMERA:{self.key}] start_camera (rclpy) fout: {e}", flush=True)

        if not success:
            try:
                import subprocess
                cmd = (
                    "source /opt/ros/galactic/setup.bash && "
                    "source /root/novabot/install/setup.bash 2>/dev/null && "
                    f'ros2 service call {service_path} std_srvs/srv/SetBool "{{data: true}}"'
                )
                env = {**os.environ, "ROS_LOCALHOST_ONLY": "1", "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp", "ROS_DOMAIN_ID": "0"}
                result = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=15, env=env)
                if "success=True" in result.stdout or "success=true" in result.stdout:
                    print(f"[CAMERA:{self.key}] start_camera (subprocess): success", flush=True)
                else:
                    print(f"[CAMERA:{self.key}] start_camera (subprocess): {result.stdout.strip()}", flush=True)
            except Exception as e:
                print(f"[CAMERA:{self.key}] start_camera (subprocess) fout: {e}", flush=True)

    def _call_stop_camera(self, node):
        """Deactiveer camera hardware via ROS service."""
        service_path = self.config['start_service']
        if not service_path or not node:
            return
        try:
            from std_srvs.srv import SetBool
            client = node.create_client(SetBool, service_path)
            if client.wait_for_service(timeout_sec=2.0):
                req = SetBool.Request()
                req.data = False
                future = client.call_async(req)
                deadline = time.time() + 3.0
                while not future.done() and time.time() < deadline:
                    time.sleep(0.1)
                if future.done() and future.result() is not None:
                    print(f"[CAMERA:{self.key}] stop_camera: success={future.result().success}", flush=True)
        except Exception:
            pass

    def _watchdog(self):
        """Controleer idle timeout."""
        while True:
            time.sleep(10)
            if not self.is_active:
                continue
            if self.active_viewers == 0 and self.last_viewer_time > 0:
                idle = time.time() - self.last_viewer_time
                if idle > IDLE_TIMEOUT:
                    print(f"[CAMERA:{self.key}] Geen viewers voor {idle:.0f}s, hardware stoppen...", flush=True)
                    self.deactivate(registry.node)


class CameraRegistry:
    """Beheert alle camera managers en de gedeelde ROS node."""

    def __init__(self):
        self.managers = {}  # type: Dict[str, CameraManager]
        self.node = None
        self._node_lock = threading.Lock()
        self._spin_thread = None

        # Pre-create managers voor alle geconfigureerde camera's
        for key, config in CAMERAS.items():
            self.managers[key] = CameraManager(key, config)

    def ensure_node(self):
        """Maak gedeelde ROS node aan (eenmalig, thread-safe)."""
        with self._node_lock:
            if self.node is not None:
                return
            self.node = rclpy.create_node('camera_stream_server')
            self._spin_thread = threading.Thread(target=self._spin, daemon=True)
            self._spin_thread.start()
            print("[CAMERA] Gedeelde ROS node aangemaakt", flush=True)

    def get(self, key: str) -> Optional[CameraManager]:
        """Haal camera manager op. Retourneert None als key onbekend."""
        return self.managers.get(key)

    def get_or_default(self, key: str) -> CameraManager:
        """Haal camera manager op, fallback naar default."""
        return self.managers.get(key, self.managers[DEFAULT_TOPIC])

    def _spin(self):
        """ROS2 spin in aparte thread."""
        try:
            rclpy.spin(self.node)
        except Exception:
            pass

    def status_all(self) -> dict:
        """JSON-serialiseerbare status van alle camera's."""
        result = {}
        for key, mgr in self.managers.items():
            result[key] = {
                'label': mgr.config['label'],
                'topic': mgr.config['topic'],
                'active': mgr.is_active,
                'frames_received': mgr.frame_count,
                'has_frame': mgr.get_frame() is not None,
                'viewers': mgr.active_viewers,
            }
        return result


# Globale registry
registry = CameraRegistry()


class StreamHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)
        topic_key = params.get('topic', [DEFAULT_TOPIC])[0]

        if path == '/stream':
            self._handle_stream(topic_key)
        elif path == '/snapshot':
            self._handle_snapshot(topic_key)
        elif path == '/status':
            self._handle_status()
        elif path == '/':
            self._handle_index()
        else:
            self.send_error(404)

    def _handle_stream(self, topic_key: str):
        """MJPEG stream voor opgegeven camera topic."""
        mgr = registry.get_or_default(topic_key)
        registry.ensure_node()
        mgr.viewer_start(registry.node)
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            interval = 1.0 / MAX_FPS
            frames_sent = 0

            # Wacht max 15s op eerste frame
            deadline = time.time() + 15.0
            while mgr.get_frame() is None and time.time() < deadline:
                time.sleep(0.2)

            while True:
                frame = mgr.get_frame()
                if frame:
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(('Content-Length: %d\r\n' % len(frame)).encode())
                    self.wfile.write(b'\r\n')
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
                    frames_sent += 1
                    if frames_sent % 100 == 1:
                        print(f"[CAMERA:{mgr.key}] Stream: {frames_sent} frames naar {self.client_address[0]}", flush=True)
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            mgr.viewer_stop()
            print(f"[CAMERA:{mgr.key}] Stream: client disconnected", flush=True)

    def _handle_snapshot(self, topic_key: str):
        """Single JPEG frame."""
        mgr = registry.get_or_default(topic_key)
        registry.ensure_node()
        mgr.viewer_start(registry.node)
        try:
            deadline = time.time() + 15.0
            while mgr.get_frame() is None and time.time() < deadline:
                time.sleep(0.2)

            frame = mgr.get_frame()
            if frame:
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(frame)))
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_response(503)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(b'Camera niet beschikbaar - probeer opnieuw')
        finally:
            mgr.viewer_stop()

    def _handle_status(self):
        """JSON status van alle camera's."""
        import json
        body = json.dumps(registry.status_all(), indent=2)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body.encode())

    def _handle_index(self):
        """Test pagina met alle camera's."""
        rows = ""
        for key, config in CAMERAS.items():
            mgr = registry.managers[key]
            rows += f'<tr><td><a href="/stream?topic={key}" style="color:#0af">{config["label"]}</a></td>'
            rows += f'<td>{"ACTIEF" if mgr.is_active else "SLAAP"}</td>'
            rows += f'<td>{mgr.frame_count}</td>'
            rows += f'<td>{mgr.active_viewers}</td>'
            rows += f'<td><a href="/snapshot?topic={key}" style="color:#0af">snapshot</a></td></tr>\n'

        html = f'''<html><head><title>Novabot Camera</title></head>
<body style="background:#111;color:#eee;margin:20px;font-family:monospace">
<h2>Novabot Multi-Camera Stream</h2>
<p>Idle timeout: {IDLE_TIMEOUT}s | Camera's activeren on-demand</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;border-color:#333">
<tr><th>Camera</th><th>Status</th><th>Frames</th><th>Viewers</th><th>Snapshot</th></tr>
{rows}
</table>
<p><a href="/status" style="color:#0af">/status</a> — JSON status alle camera's</p>
<hr>
<h3>Front camera preview:</h3>
<img src="/stream?topic=front" style="max-width:100%;border:1px solid #333" onerror="this.alt='Stream niet beschikbaar'">
</body></html>'''
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(html)))
        self.end_headers()
        self.wfile.write(html.encode())

    def log_message(self, format, *args):
        pass


def main():
    global rclpy
    print("[CAMERA] === Novabot Multi-Camera Stream Server ===", flush=True)
    print(f"[CAMERA] PID={os.getpid()}", flush=True)
    print(f"[CAMERA] {len(CAMERAS)} camera's geconfigureerd, idle timeout {IDLE_TIMEOUT}s", flush=True)
    for key, config in CAMERAS.items():
        print(f"[CAMERA]   {key}: {config['topic']} ({config['msg_type']})", flush=True)

    # ROS 2 eenmalig initialiseren
    import rclpy as _rclpy
    rclpy = _rclpy
    rclpy.init()
    print("[CAMERA] ROS 2 geinitialiseerd", flush=True)

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadingHTTPServer(('0.0.0.0', HTTP_PORT), StreamHandler)
    print(f'[CAMERA] HTTP server op http://0.0.0.0:{HTTP_PORT}/', flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[CAMERA] Ctrl+C", flush=True)
    finally:
        server.server_close()
        for mgr in registry.managers.values():
            if mgr.is_active:
                mgr.deactivate(registry.node)
        try:
            rclpy.shutdown()
        except Exception:
            pass
        print("[CAMERA] Server gestopt", flush=True)


if __name__ == '__main__':
    main()
