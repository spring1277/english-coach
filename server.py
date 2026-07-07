# -*- coding: utf-8 -*-
"""English Coach - 로컬 서버
정적 파일 서빙 + Azure Pronunciation Assessment 프록시 + edge-tts 원어민 음성
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


def azure_assess(audio_bytes, ref_text, cfg):
    """Azure Speech SDK로 발음 평가.
    (REST 단문 API는 koreacentral 등 일부 리전에서 발음평가 헤더를 거부하므로 SDK 사용)
    """
    region = cfg.get("azure_region", "koreacentral")
    key = cfg.get("azure_key", "")
    if not key:
        raise RuntimeError("NO_KEY")
    try:
        import azure.cognitiveservices.speech as speechsdk
    except ImportError:
        raise RuntimeError(
            "Speech SDK가 없습니다. 터미널에서 실행하세요: pip install azure-cognitiveservices-speech"
        )

    import tempfile
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(audio_bytes)

        speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
        audio_config = speechsdk.audio.AudioConfig(filename=wav_path)
        pa = speechsdk.PronunciationAssessmentConfig(
            reference_text=ref_text,
            grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
            granularity=speechsdk.PronunciationAssessmentGranularity.Phoneme,
            enable_miscue=True,
        )
        pa.phoneme_alphabet = "IPA"
        pa.enable_prosody_assessment()
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config, language="en-US", audio_config=audio_config
        )
        pa.apply_to(recognizer)
        result = recognizer.recognize_once()

        if result.reason == speechsdk.ResultReason.RecognizedSpeech:
            detail = json.loads(
                result.properties.get(speechsdk.PropertyId.SpeechServiceResponse_JsonResult)
            )
            detail.setdefault("RecognitionStatus", "Success")
            return detail
        if result.reason == speechsdk.ResultReason.NoMatch:
            return {"RecognitionStatus": "InitialSilenceTimeout"}
        if result.reason == speechsdk.ResultReason.Canceled:
            cd = result.cancellation_details
            msg = cd.error_details or str(cd.reason)
            if "401" in msg or "Authentication" in msg or "1006" in msg:
                raise RuntimeError("Azure 인증 실패 — 키/리전을 확인하세요.")
            raise RuntimeError(f"Azure 오류: {msg[:200]}")
        return {"RecognitionStatus": str(result.reason)}
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass


def simplify(azure_resp):
    """Azure 응답을 프런트가 쓰기 좋은 형태로 축약."""
    status = azure_resp.get("RecognitionStatus", "Unknown")
    if status != "Success":
        return {"ok": False, "status": status}
    nbest = (azure_resp.get("NBest") or [{}])[0]
    pa = nbest.get("PronunciationAssessment", {})
    words = []
    for w in nbest.get("Words", []):
        wpa = w.get("PronunciationAssessment", {})
        words.append({
            "word": w.get("Word", ""),
            "score": wpa.get("AccuracyScore"),
            "error": wpa.get("ErrorType", "None"),
            "phonemes": [
                {
                    "p": ph.get("Phoneme", ""),
                    "score": ph.get("PronunciationAssessment", {}).get("AccuracyScore"),
                }
                for ph in w.get("Phonemes", [])
            ],
        })
    return {
        "ok": True,
        "status": status,
        "recognized": nbest.get("Display", ""),
        "pron": pa.get("PronScore"),
        "accuracy": pa.get("AccuracyScore"),
        "fluency": pa.get("FluencyScore"),
        "completeness": pa.get("CompletenessScore"),
        "prosody": pa.get("ProsodyScore"),
        "words": words,
    }


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
            key = cfg.get("azure_key", "")
            gemini = cfg.get("gemini_key", "")
            self._json({
                "region": cfg.get("azure_region", "koreacentral"),
                "hasKey": bool(key),
                "keyMasked": (key[:4] + "…" + key[-4:]) if len(key) > 8 else "",
                # 로컬 전용 앱: 브라우저가 Gemini Live WebSocket에 직접 연결하므로 키 원문 반환
                "geminiKey": gemini,
                "hasGemini": bool(gemini),
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

        elif parsed.path == "/api/assess":
            qs = urllib.parse.parse_qs(parsed.query)
            ref_text = (qs.get("text") or [""])[0].strip()
            if not ref_text:
                self._json({"error": "reference text 누락"}, 400)
                return
            if len(body) < 1000:
                self._json({"error": "오디오가 너무 짧습니다"}, 400)
                return
            try:
                result = simplify(azure_assess(body, ref_text, load_config()))
                self._json(result)
            except RuntimeError as e:
                if str(e) == "NO_KEY":
                    self._json({"error": "Azure 키가 설정되지 않았습니다. ⚙️ 설정에서 입력하세요."}, 400)
                else:
                    self._json({"error": str(e)}, 500)
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = e.read().decode("utf-8")[:300]
                except Exception:
                    pass
                if e.code in (401, 403):
                    msg = "Azure 인증 실패 — 키/리전을 확인하세요."
                else:
                    msg = f"Azure 오류 (HTTP {e.code}) {detail}"
                self._json({"error": msg}, 502)
            except Exception as e:
                self._json({"error": f"서버 오류: {e}"}, 500)
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    os.makedirs(TTS_DIR, exist_ok=True)
    print(f"English Coach server → http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
