#!/usr/bin/env python3
"""
MJPEG HTTP server voor Novabot maaier camera stream.

LAZY MODE: ROS subscriber + camera worden pas geactiveerd bij het eerste
HTTP request, en weer gestopt na 60s zonder viewers. CPU overhead ~0%
als niemand kijkt.

Endpoints:
  /stream   -> MJPEG stream (~10fps)
  /snapshot -> Single JPEG frame
  /status   -> JSON status
  /         -> Test pagina
"""

from typing import Optional
import os
import signal
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

rclpy = None  # Wordt geinitialiseerd in main()

# Graceful shutdown bij SIGTERM (run_novabot.sh stop)
def _sigterm_handler(signum, frame):
    print("[CAMERA] SIGTERM ontvangen, afsluiten...", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, _sigterm_handler)

# Configuratie
ROS_TOPIC = '/camera/preposition/image_half/compressed'
HTTP_PORT = 8000
MAX_FPS = 10
IDLE_TIMEOUT = 60  # seconden zonder viewers -> camera uit


class CameraManager:
    """Beheert lazy ROS subscription + camera activatie.

    BELANGRIJK: rclpy wordt EEN KEER geinitialiseerd in main() en NOOIT
    afgesloten. De deactivate/activate cyclus vernietigt/maakt alleen de
    node + subscription. Dit voorkomt de deadlock die ontstaat als
    rclpy.shutdown() + rclpy.init() herhaald wordt (ROS 2 Galactic bug).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active = False
        self._node = None
        self._spin_thread = None
        self._watchdog_thread = None

        # Frame data
        self.latest_frame = None  # type: Optional[bytes]
        self.frame_lock = threading.Lock()
        self.frame_count = 0

        # Viewer tracking
        self.active_viewers = 0
        self.last_viewer_time = 0.0

    def activate(self):
        """Activeer ROS subscriber + camera. Idempotent."""
        with self._lock:
            if self._active:
                return
            self._active = True

        print("[CAMERA] === Camera activeren (lazy) ===", flush=True)

        try:
            from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
            from sensor_msgs.msg import CompressedImage
        except ImportError as e:
            print(f"[CAMERA] FATAL: ROS 2 import failed: {e}", flush=True)
            with self._lock:
                self._active = False
            return

        # Maak node + subscriber (rclpy is al geinitialiseerd in main())
        self._node = rclpy.create_node('camera_stream_server')
        qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        self._node.create_subscription(CompressedImage, ROS_TOPIC, self._frame_callback, qos)
        print(f"[CAMERA] Subscribed op {ROS_TOPIC}", flush=True)

        # Spin thread
        self._spin_thread = threading.Thread(target=self._spin, daemon=True)
        self._spin_thread.start()

        # Activeer camera via ROS service
        self._call_start_camera()

        # Start watchdog (checkt idle timeout)
        if self._watchdog_thread is None or not self._watchdog_thread.is_alive():
            self._watchdog_thread = threading.Thread(target=self._watchdog, daemon=True)
            self._watchdog_thread.start()

        print("[CAMERA] Camera actief", flush=True)

    def deactivate(self):
        """Stop ROS subscriber + camera. Idempotent.

        Vernietigt alleen de node — rclpy blijft geinitialiseerd zodat
        activate() later opnieuw een node kan aanmaken zonder deadlock.
        """
        with self._lock:
            if not self._active:
                return
            self._active = False

        print("[CAMERA] === Camera deactiveren (idle timeout) ===", flush=True)

        # Stop camera hardware
        self._call_stop_camera()

        # Destroy node (spin thread stopt automatisch)
        try:
            if self._node:
                self._node.destroy_node()
                self._node = None
        except Exception as e:
            print(f"[CAMERA] Deactivate fout: {e}", flush=True)

        # Wacht tot spin thread stopt
        if self._spin_thread and self._spin_thread.is_alive():
            self._spin_thread.join(timeout=3.0)
        self._spin_thread = None

        # Reset frame data
        with self.frame_lock:
            self.latest_frame = None
            self.frame_count = 0

        print("[CAMERA] Camera gestopt", flush=True)

    @property
    def is_active(self):
        with self._lock:
            return self._active

    def get_frame(self):
        # type: () -> Optional[bytes]
        with self.frame_lock:
            return self.latest_frame

    def viewer_start(self):
        """Registreer een nieuwe viewer."""
        self.active_viewers += 1
        self.last_viewer_time = time.time()
        if not self.is_active:
            self.activate()

    def viewer_stop(self):
        """Deregistreer een viewer."""
        self.active_viewers = max(0, self.active_viewers - 1)
        self.last_viewer_time = time.time()

    def _frame_callback(self, msg):
        data = bytes(msg.data)
        with self.frame_lock:
            self.latest_frame = data
            self.frame_count += 1

        # Periodiek loggen
        if self.frame_count == 1 or self.frame_count % 300 == 0:
            print(f"[CAMERA] Frame #{self.frame_count}: {len(data)} bytes", flush=True)

    def _spin(self):
        """ROS 2 spin in aparte thread. Stopt als node wordt vernietigd."""
        try:
            rclpy.spin(self._node)
        except Exception:
            pass

    def _call_start_camera(self):
        """Activeer camera hardware via ROS service."""
        try:
            from std_srvs.srv import SetBool
            client = self._node.create_client(SetBool, '/camera/preposition/start_camera')
            if client.wait_for_service(timeout_sec=5.0):
                req = SetBool.Request()
                req.data = True
                future = client.call_async(req)
                deadline = time.time() + 5.0
                while not future.done() and time.time() < deadline:
                    time.sleep(0.1)
                if future.done() and future.result() is not None:
                    print(f"[CAMERA] start_camera: success={future.result().success}", flush=True)
                else:
                    print("[CAMERA] start_camera: timeout", flush=True)
            else:
                print("[CAMERA] start_camera service niet beschikbaar", flush=True)
        except Exception as e:
            print(f"[CAMERA] start_camera fout: {e}", flush=True)

    def _call_stop_camera(self):
        """Deactiveer camera hardware via ROS service."""
        if not self._node:
            return
        try:
            from std_srvs.srv import SetBool
            client = self._node.create_client(SetBool, '/camera/preposition/start_camera')
            if client.wait_for_service(timeout_sec=2.0):
                req = SetBool.Request()
                req.data = False
                future = client.call_async(req)
                deadline = time.time() + 3.0
                while not future.done() and time.time() < deadline:
                    time.sleep(0.1)
                if future.done() and future.result() is not None:
                    print(f"[CAMERA] stop_camera: success={future.result().success}", flush=True)
        except Exception:
            pass

    def _watchdog(self):
        """Controleer elke 10s of er nog viewers zijn. Stop camera na idle timeout."""
        while True:
            time.sleep(10)
            if not self.is_active:
                continue
            if self.active_viewers == 0 and self.last_viewer_time > 0:
                idle = time.time() - self.last_viewer_time
                if idle > IDLE_TIMEOUT:
                    print(f"[CAMERA] Geen viewers voor {idle:.0f}s, camera stoppen...", flush=True)
                    self.deactivate()


# Globale camera manager
cam = CameraManager()


class StreamHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/stream':
            self._handle_stream()
        elif path == '/snapshot':
            self._handle_snapshot()
        elif path == '/status':
            self._handle_status()
        elif path == '/':
            self._handle_index()
        else:
            self.send_error(404)

    def _handle_stream(self):
        """MJPEG stream — multipart/x-mixed-replace"""
        cam.viewer_start()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            interval = 1.0 / MAX_FPS
            frames_sent = 0

            # Wacht max 10s op eerste frame
            deadline = time.time() + 10.0
            while cam.get_frame() is None and time.time() < deadline:
                time.sleep(0.2)

            while True:
                frame = cam.get_frame()
                if frame:
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(('Content-Length: %d\r\n' % len(frame)).encode())
                    self.wfile.write(b'\r\n')
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
                    frames_sent += 1
                    if frames_sent % 100 == 1:
                        print(f"[CAMERA] Stream: {frames_sent} frames naar {self.client_address[0]}", flush=True)
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            cam.viewer_stop()
            print(f"[CAMERA] Stream: client {self.client_address[0]} disconnected", flush=True)

    def _handle_snapshot(self):
        """Single JPEG frame"""
        cam.viewer_start()
        try:
            # Wacht max 10s op eerste frame
            deadline = time.time() + 10.0
            while cam.get_frame() is None and time.time() < deadline:
                time.sleep(0.2)

            frame = cam.get_frame()
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
            cam.viewer_stop()

    def _handle_status(self):
        """JSON status endpoint"""
        body = '{"active":%s,"frames_received":%d,"has_frame":%s,"viewers":%d,"topic":"%s"}' % (
            'true' if cam.is_active else 'false',
            cam.frame_count,
            'true' if cam.get_frame() is not None else 'false',
            cam.active_viewers,
            ROS_TOPIC)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())

    def _handle_index(self):
        """Simple HTML page for testing"""
        html = '''<html><head><title>Novabot Camera</title></head>
<body style="background:#111;color:#eee;margin:20px;font-family:monospace">
<h2>Novabot Camera Stream</h2>
<p>Camera modus: <b>LAZY</b> — activeert bij eerste request, stopt na %ds idle</p>
<p>Status: <b>%s</b> | Frames: %d | Viewers: %d</p>
<p><a href="/status" style="color:#0af">/status</a> - JSON status</p>
<p><a href="/snapshot" style="color:#0af">/snapshot</a> - Single JPEG frame</p>
<p><a href="/stream" style="color:#0af">/stream</a> - MJPEG stream</p>
<hr>
<h3>Live preview:</h3>
<img src="/stream" style="max-width:100%%;border:1px solid #333" onerror="this.alt='Stream niet beschikbaar'">
</body></html>''' % (IDLE_TIMEOUT, 'ACTIEF' if cam.is_active else 'SLAAPSTAND', cam.frame_count, cam.active_viewers)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(html)))
        self.end_headers()
        self.wfile.write(html.encode())

    def log_message(self, format, *args):
        pass


def main():
    global rclpy
    print("[CAMERA] === Novabot Camera Stream Server (LAZY MODE) ===", flush=True)
    print(f"[CAMERA] PID={os.getpid()}", flush=True)
    print(f"[CAMERA] Camera activeert on-demand, stopt na {IDLE_TIMEOUT}s idle", flush=True)

    # ROS 2 eenmalig initialiseren — wordt NOOIT afgesloten.
    # activate()/deactivate() maken alleen nodes aan/vernietigen ze.
    import rclpy as _rclpy
    rclpy = _rclpy
    rclpy.init()
    print("[CAMERA] ROS 2 geinitialiseerd (eenmalig)", flush=True)

    server = HTTPServer(('0.0.0.0', HTTP_PORT), StreamHandler)
    print(f'[CAMERA] HTTP server luistert op http://0.0.0.0:{HTTP_PORT}/', flush=True)
    print(f'[CAMERA] ROS subscription start pas bij eerste request', flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[CAMERA] Ctrl+C ontvangen", flush=True)
    finally:
        server.server_close()
        if cam.is_active:
            cam.deactivate()
        try:
            rclpy.shutdown()
        except Exception:
            pass
        print("[CAMERA] Server gestopt", flush=True)


if __name__ == '__main__':
    main()
