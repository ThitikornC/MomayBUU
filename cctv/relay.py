"""
MomayBUU CCTV Relay — Ultra Low-Latency Edition

Captures RTSP via OpenCV in a separate thread → sends JPEG frames to server.
Only the LATEST frame is ever sent — stale frames are always dropped.

Key optimizations:
  - Threaded capture: never blocks on camera read
  - Always sends the latest frame only (no buffering)
  - Skip on backpressure (if WS is slow, drop frame instead of queue)
  - Uses sub-stream (subtype=1) for lower resolution = faster encode
  - Minimal OpenCV buffer
"""

import os
import sys
import time
import asyncio
import signal
import logging
import threading

import cv2
import websockets
from dotenv import load_dotenv

load_dotenv()

# ─── Config ───
RTSP_URL     = os.getenv("RTSP_URL", "rtsp://admin:Ice08881t0287@192.168.1.72:554/cam/realmonitor?channel=1&subtype=1")
SERVER_URL   = os.getenv("SERVER_URL", "ws://localhost:8000/ws/relay")
RELAY_KEY    = os.getenv("RELAY_KEY", "changeme")
FRAME_WIDTH  = int(os.getenv("FRAME_WIDTH", "640"))
FRAME_HEIGHT = int(os.getenv("FRAME_HEIGHT", "480"))
TARGET_FPS   = int(os.getenv("FPS", "20"))
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "45"))  # lower = faster + less bandwidth

RECONNECT_DELAY = 3  # seconds

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("relay")

should_run = True


def signal_handler(sig, frame):
    global should_run
    logger.info("Shutting down...")
    should_run = False
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


class RTSPCapture:
    """Threaded RTSP capture — always holds only the LATEST frame."""

    def __init__(self, url: str, width: int, height: int):
        self.url = url
        self.width = width
        self.height = height
        self.frame = None
        self.lock = threading.Lock()
        self.running = False
        self.cap = None
        self.thread = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.cap:
            self.cap.release()

    def get_frame(self):
        """Get the latest frame (non-blocking). Returns None if no frame."""
        with self.lock:
            return self.frame

    def _capture_loop(self):
        """Runs in a separate thread — continuously grabs the latest frame."""
        logger.info(f"Opening RTSP: {self.url}")

        # FFmpeg options for low latency
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|framedrop;1"
        )

        self.cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not self.cap.isOpened():
            logger.error(f"Cannot open RTSP: {self.url}")
            self.running = False
            return

        logger.info("✓ Camera opened — capturing frames")

        while self.running:
            # grab() + retrieve() is faster than read() — grab discards old buffer
            if not self.cap.grab():
                logger.warning("grab() failed — camera disconnected")
                break

            ret, frame = self.cap.retrieve()
            if not ret:
                continue

            # Resize immediately in capture thread
            if frame.shape[1] != self.width or frame.shape[0] != self.height:
                frame = cv2.resize(frame, (self.width, self.height),
                                   interpolation=cv2.INTER_NEAREST)

            with self.lock:
                self.frame = frame  # always overwrite = only latest

        self.cap.release()
        self.running = False


async def relay_stream():
    """Main loop: grab latest frame → encode → send."""
    global should_run

    ws_url = f"{SERVER_URL}?key={RELAY_KEY}"
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
    frame_interval = 1.0 / TARGET_FPS

    while should_run:
        capture = None
        ws = None

        try:
            # Start threaded capture
            capture = RTSPCapture(RTSP_URL, FRAME_WIDTH, FRAME_HEIGHT)
            capture.start()

            # Wait for first frame
            for _ in range(50):
                if capture.get_frame() is not None:
                    break
                await asyncio.sleep(0.1)

            if capture.get_frame() is None:
                raise ConnectionError("No frames from camera in 5s")

            # Connect to server
            logger.info(f"Connecting to: {SERVER_URL}")
            ws = await websockets.connect(
                ws_url,
                ping_interval=10,
                ping_timeout=5,
                max_size=2**20,
                close_timeout=3,
            )
            logger.info("✓ Connected — streaming started")

            sent = 0
            skip = 0
            log_time = time.time()

            while should_run and capture.running:
                t0 = time.monotonic()

                frame = capture.get_frame()
                if frame is None:
                    await asyncio.sleep(0.005)
                    continue

                # Encode JPEG
                ok, jpeg = cv2.imencode(".jpg", frame, encode_params)
                if not ok:
                    continue

                data = jpeg.tobytes()

                # Send with timeout — drop frame if WS is backed up
                try:
                    await asyncio.wait_for(ws.send(data), timeout=0.08)
                    sent += 1
                except asyncio.TimeoutError:
                    skip += 1
                except websockets.exceptions.ConnectionClosed:
                    logger.warning("Server connection lost")
                    break

                # Stats every 5s
                now = time.time()
                if now - log_time >= 5.0:
                    logger.info(f"sent={sent} skip={skip} size={len(data)//1024}KB")
                    sent = skip = 0
                    log_time = now

                # Frame rate control
                dt = time.monotonic() - t0
                if dt < frame_interval:
                    await asyncio.sleep(frame_interval - dt)

        except ConnectionError as e:
            logger.error(f"Camera: {e}")
        except websockets.exceptions.ConnectionClosed:
            logger.warning("Server disconnected")
        except Exception as e:
            logger.error(f"Error: {e}")
        finally:
            if capture:
                capture.stop()
            if ws:
                try: await ws.close()
                except: pass

        if should_run:
            logger.info(f"Reconnecting in {RECONNECT_DELAY}s...")
            await asyncio.sleep(RECONNECT_DELAY)


def main():
    print("╔══════════════════════════════════════════╗")
    print("║  MomayBUU CCTV Relay — Realtime Edition  ║")
    print("╚══════════════════════════════════════════╝")
    print(f"  RTSP:    {RTSP_URL}")
    print(f"  Server:  {SERVER_URL}")
    print(f"  Size:    {FRAME_WIDTH}x{FRAME_HEIGHT} @ {TARGET_FPS}fps")
    print(f"  JPEG:    {JPEG_QUALITY}% quality")
    print()
    asyncio.run(relay_stream())


if __name__ == "__main__":
    main()
