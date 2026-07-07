# -*- coding: utf-8 -*-
"""English Coach - 로컬 개발 서버 (선택 사항)
앱은 완전 정적(GitHub Pages 배포 가능)이며, 이 서버는 PC에서 편의 기능만 제공:
  - 정적 파일 서빙
  - /api/tts    : edge-tts 원어민 음성 (없으면 앱이 Azure TTS/브라우저 TTS로 폴백)
  - /api/config : 키를 config.json에 백업 저장/이관 (앱의 기본 저장소는 localStorage)
실행: python english-coach/server.py  →  http://localhost:8735
"""
import asyncio
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
TTS_DIR = os.path.join(BASE, "tts_cache")
PORT = 8735
TTS_VOICE = "en-US-JennyNeural"


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {"azure_key": "", "azure_region": "koreacentral", "gemini_key": ""}


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def azure_test_key(cfg):
    region = cfg.get("azure_region", "koreacentral")
    key = cfg.get("azure_key", "")
    if not key:
        return False, "키가 비어 있습니다"
    url = f"https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
    req = urllib.request.Request(
        url, data=b"", headers={"Ocp-Apim-Subscription-Key": key}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15):
            return True, "연결 성공"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, "키가 올바르지 않거나 리전이 다릅니다"
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)


def edge_tts_generate(text):
    """edge-tts로 원어민 mp3 생성(캐시). 미설치면 None."""
    try:
        import edge_tts
    except ImportError:
        return None
    os.makedirs(TTS_DIR, exist_ok=True)
    h = hashlib.md5((TTS_VOICE + text).encode("utf-8")).hexdigest()
    path = os.path.join(TTS_DIR, h + ".mp3")
    if not os.path.exists(path):
        async def gen():
            await edge_tts.Communicate(text, TTS_VOICE, rate="-10%").save(path)
        asyncio.run(gen())
    return path


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 콘솔 소음 줄이기

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            cfg = load_config()
            # 로컬 전용 서버: 브라우저(localStorage)로 키를 이관하기 위해 원문 반환
            self._json({
                "region": cfg.get("azure_region", "koreacentral"),
                "azureKey": cfg.get("azure_key", ""),
                "geminiKey": cfg.get("gemini_key", ""),
            })
        elif parsed.path == "/api/test":
            ok, msg = azure_test_key(load_config())
            self._json({"ok": ok, "message": msg})
        elif parsed.path == "/api/tts":
            qs = urllib.parse.parse_qs(parsed.query)
            text = (qs.get("text") or [""])[0].strip()
            if not text or len(text) > 500:
                self._json({"error": "bad text"}, 400)
                return
            try:
                path = edge_tts_generate(text)
            except Exception as e:
                self._json({"error": str(e)}, 500)
                return
            if path is None:
                self._json({"error": "edge-tts not installed"}, 404)
                return
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""

        if parsed.path == "/api/config":
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                self._json({"error": "bad json"}, 400)
                return
            cfg = load_config()
            if data.get("azure_key"):
                cfg["azure_key"] = data["azure_key"].strip()
            if data.get("azure_region"):
                cfg["azure_region"] = data["azure_region"].strip()
            if data.get("gemini_key"):
                cfg["gemini_key"] = data["gemini_key"].strip()
            save_config(cfg)
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    os.makedirs(TTS_DIR, exist_ok=True)
    print(f"English Coach server → http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
