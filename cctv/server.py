"""
MomayBUU CCTV Server — Runs on Railway (or local for testing)

Architecture:
  [RTSP Camera] ← OpenCV ← relay.py (local) ──WebSocket──▶ server.py (Railway) ──WebSocket──▶ Browser

Endpoints:
  GET  /              → Player page (public/index.html)
  WS   /ws/stream     → Browser connects here to watch (JPEG frames)
  WS   /ws/relay      → relay.py sends JPEG frames here
  GET  /health        → Health check
"""

import os
import asyncio
import logging
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from dotenv import load_dotenv

load_dotenv()

RELAY_KEY = os.getenv("RELAY_KEY", "changeme")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("cctv-server")

app = FastAPI(title="MomayBUU CCTV Server")

# ─── State ───
relay_ws: WebSocket | None = None
viewer_clients: Set[WebSocket] = set()
latest_frame: bytes | None = None  # เก็บ frame ล่าสุดให้ viewer ใหม่เห็นทันที


@app.get("/health")
async def health():
    return JSONResponse({
        "status": "ok",
        "viewers": len(viewer_clients),
        "relay_connected": relay_ws is not None,
    })


@app.websocket("/ws/relay")
async def relay_endpoint(websocket: WebSocket, key: str = Query("")):
    global relay_ws, latest_frame

    # Authenticate
    if key != RELAY_KEY:
        await websocket.close(code=1008, reason="Unauthorized")
        logger.warning("Relay rejected — bad key")
        return

    await websocket.accept()

    # Replace existing relay
    if relay_ws is not None:
        try:
            await relay_ws.close()
        except Exception:
            pass
        logger.info("Replaced existing relay connection")

    relay_ws = websocket
    logger.info(f"✓ Relay connected — viewers: {len(viewer_clients)}")

    try:
        while True:
            # Receive JPEG frame bytes from relay
            data = await websocket.receive_bytes()
            latest_frame = data

            # Broadcast to all viewers concurrently
            if viewer_clients:
                dead = []
                async def _send(v, d):
                    try:
                        await asyncio.wait_for(v.send_bytes(d), timeout=0.15)
                    except Exception:
                        dead.append(v)

                await asyncio.gather(*[_send(v, data) for v in viewer_clients])
                for d in dead:
                    viewer_clients.discard(d)

    except WebSocketDisconnect:
        logger.info("✗ Relay disconnected")
    except Exception as e:
        logger.error(f"Relay error: {e}")
    finally:
        if relay_ws is websocket:
            relay_ws = None


@app.websocket("/ws/stream")
async def stream_endpoint(websocket: WebSocket):
    global latest_frame

    await websocket.accept()
    viewer_clients.add(websocket)
    logger.info(f"+ Viewer connected — total: {len(viewer_clients)}")

    # Send latest frame immediately so viewer doesn't see blank
    if latest_frame:
        try:
            await websocket.send_bytes(latest_frame)
        except Exception:
            pass

    try:
        # Keep connection alive — just wait for disconnect
        while True:
            await websocket.receive_text()  # ping/pong or any message
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        viewer_clients.discard(websocket)
        logger.info(f"- Viewer disconnected — total: {len(viewer_clients)}")


# ─── Static files (standalone player page) ───
_public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
if os.path.isdir(_public_dir):
    app.mount("/", StaticFiles(directory=_public_dir, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "3100"))
    logger.info(f"Starting CCTV server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
