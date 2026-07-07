/* English Coach — 발음 트레이너 + 회화 수업 (완전 정적 PWA)
   발음 채점: Azure Speech JS SDK (브라우저 직접 연결)
   회화 수업: Gemini Live API (브라우저 WebSocket 직접 연결)
   키 저장: localStorage (기기별) — 로컬 서버가 있으면 최초 1회 이관 */
const $ = (s) => document.querySelector(s);

const state = {
  category: "daily",
  idx: 0,
  customSentence: "",
  recording: false,
  lastBlobUrl: null,
  ttsAudio: null,
  azureKey: "",
  region: "koreacentral",
  geminiKey: "",
};

const MAX_REC_SEC = 20;

/* ---------- WAV 녹음기 (16kHz mono PCM) ---------- */
class WavRecorder {
  async start(onLevel) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(d));
      let sum = 0;
      for (let i = 0; i < d.length; i += 8) sum += d[i] * d[i];
      onLevel && onLevel(Math.min(1, Math.sqrt(sum / (d.length / 8)) * 6));
    };
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
  }

  async stop() {
    this.proc.disconnect();
    this.src.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    const rate = this.ctx.sampleRate;
    await this.ctx.close();
    return this.encodeWav(this.merge(), rate, 16000);
  }

  merge() {
    const len = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(len);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  encodeWav(samples, srcRate, dstRate) {
    // 다운샘플 (평균 필터)
    const ratio = srcRate / dstRate;
    const n = Math.floor(samples.length / ratio);
    const ds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio), end = Math.min(Math.floor((i + 1) * ratio), samples.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      ds[i] = sum / Math.max(1, end - start);
    }
    // 16-bit PCM WAV
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, dstRate, true);
    v.setUint32(28, dstRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    writeStr(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, ds[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
}

/* ---------- 일별 집계 (localStorage, 대시보드용) ---------- */
function todayKey() { return new Date().toISOString().slice(0, 10); }

function bumpDaily(patch) {
  const daily = JSON.parse(localStorage.getItem("ec_daily") || "{}");
  const k = todayKey();
  const d = daily[k] || { n: 0, pronSum: 0, best: 0, convSec: 0 };
  if (patch.pron != null) {
    d.n += 1;
    d.pronSum += patch.pron;
    d.best = Math.max(d.best, patch.pron);
  }
  if (patch.convSec) d.convSec += patch.convSec;
  daily[k] = d;
  localStorage.setItem("ec_daily", JSON.stringify(daily));
}

/* ---------- 오답 은행 (localStorage) ---------- */
function getBank() { return JSON.parse(localStorage.getItem("ec_wrongbank") || "[]"); }
function setBank(bank) { localStorage.setItem("ec_wrongbank", JSON.stringify(bank)); }
function reviewItems() { return getBank().filter((b) => !b.grad); }

function addToBank(corrections, topic) {
  const bank = getBank();
  let added = 0;
  for (const c of corrections || []) {
    if (!c || !c.right || !c.wrong) continue;
    const norm = String(c.right).trim().toLowerCase();
    if (!norm || bank.some((b) => b.right.trim().toLowerCase() === norm)) continue;
    bank.unshift({
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      wrong: String(c.wrong).trim(),
      right: String(c.right).trim(),
      reason: String(c.reason || "").trim(),
      topic: topic || "",
      d: new Date().toISOString().slice(0, 10),
      drill: 0,
      grad: false,
    });
    added++;
  }
  setBank(bank.slice(0, 100));
  renderBank();
  return added;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBank() {
  const bank = getBank();
  const el = $("#wrongBank");
  if (!bank.length) {
    el.textContent = "아직 없습니다. 💬 회화 수업 후 리포트를 만들면 자동으로 쌓입니다.";
    return;
  }
  el.innerHTML = "";
  bank.slice(0, 12).forEach((b) => {
    const item = document.createElement("div");
    item.className = "bank-item" + (b.grad ? " grad" : "");
    item.innerHTML =
      `<div class="bank-main"><span class="b-right">✅ ${escapeHtml(b.right)}</span>` +
      `<span class="b-wrong">❌ ${escapeHtml(b.wrong)}</span></div>` +
      `<span class="b-badge">${b.grad ? "🎓 졸업" : "🔁 " + (b.drill || 0) + "회"}</span>` +
      `<button class="b-del" title="삭제">✕</button>`;
    item.querySelector(".bank-main").onclick = () => {
      const items = reviewItems();
      const i = items.findIndex((x) => x.id === b.id);
      state.category = "review";
      state.idx = i >= 0 ? i : 0;
      $("#customBox").classList.add("hidden");
      renderTabs();
      renderSentence();
      switchMode("pron");
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    item.querySelector(".b-del").onclick = () => {
      setBank(getBank().filter((x) => x.id !== b.id));
      renderBank();
      if (state.category === "review") renderSentence();
    };
    el.appendChild(item);
  });
}

/* ---------- 문장 관리 ---------- */
function currentSentence() {
  if (state.category === "custom") return { text: state.customSentence };
  if (state.category === "review") {
    const items = reviewItems();
    if (!items.length) return { text: "", review: null };
    const it = items[state.idx % items.length];
    return { text: it.right, tip: it.reason, review: it };
  }
  const list = SENTENCES[state.category];
  return list[state.idx % list.length];
}

function renderSentence() {
  const s = currentSentence();
  const isReview = state.category === "review";
  $("#answerRow").classList.toggle("hidden", !(isReview && s.review));
  $("#answerText").classList.add("hidden");
  if (isReview && !s.review) {
    $("#sentence").textContent = "오답 은행이 비어 있습니다 — 💬 회화 수업 후 리포트를 만들면 자동으로 쌓입니다.";
  } else if (isReview) {
    $("#sentence").textContent = "🔁 고쳐 말하기: ❌ " + s.review.wrong;
    $("#answerText").textContent = "✅ " + s.review.right;
  } else {
    $("#sentence").textContent = s.text || "(문장을 입력하세요)";
  }
  const tipEl = $("#tip");
  if (s.tip) { tipEl.textContent = "💡 " + s.tip; tipEl.classList.remove("hidden"); }
  else tipEl.classList.add("hidden");
  $("#result").classList.add("hidden");
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const key of ["daily", "medical", "drill", "review", "custom"]) {
    const b = document.createElement("button");
    b.className = "tab" + (state.category === key ? " active" : "");
    b.textContent = CATEGORY_LABELS[key];
    b.onclick = () => {
      state.category = key;
      state.idx = 0;
      $("#customBox").classList.toggle("hidden", key !== "custom");
      renderTabs();
      renderSentence();
    };
    tabs.appendChild(b);
  }
}

/* ---------- 원어민 듣기 (로컬서버 edge-tts → Azure TTS → 브라우저 TTS) ---------- */
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sdkSpeak(text) {
  return new Promise((resolve, reject) => {
    if (!state.azureKey || typeof SpeechSDK === "undefined") return reject(new Error("no sdk"));
    const sc = SpeechSDK.SpeechConfig.fromSubscription(state.azureKey, state.region);
    const synth = new SpeechSDK.SpeechSynthesizer(sc);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
      `<voice name="en-US-JennyNeural"><prosody rate="-10%">${escapeXml(text)}</prosody></voice></speak>`;
    synth.speakSsmlAsync(
      ssml,
      (r) => {
        synth.close();
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) resolve();
        else reject(new Error(r.errorDetails || "tts failed"));
      },
      (e) => { synth.close(); reject(new Error(String(e))); }
    );
  });
}

async function playModel() {
  const text = currentSentence().text;
  if (!text) return;
  $("#btnListen").disabled = true;
  try {
    // 1) 로컬 서버 edge-tts (PC에서만 성공)
    const res = await fetch("/api/tts?text=" + encodeURIComponent(text));
    if (!res.ok || !(res.headers.get("content-type") || "").includes("audio")) throw new Error("no server tts");
    const blob = await res.blob();
    if (state.ttsAudio) state.ttsAudio.pause();
    state.ttsAudio = new Audio(URL.createObjectURL(blob));
    await state.ttsAudio.play();
  } catch {
    try {
      // 2) Azure TTS (같은 키, 무료 티어)
      await sdkSpeak(text);
    } catch {
      // 3) 브라우저 내장 TTS
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
  } finally {
    $("#btnListen").disabled = false;
  }
}

/* ---------- 발음 채점 (Azure Speech JS SDK — 브라우저 직접) ---------- */
function parseAzureDetail(detail) {
  const nb = (detail.NBest || [{}])[0];
  const pa = nb.PronunciationAssessment || {};
  return {
    ok: true,
    recognized: nb.Display || "",
    pron: pa.PronScore,
    accuracy: pa.AccuracyScore,
    fluency: pa.FluencyScore,
    completeness: pa.CompletenessScore,
    prosody: pa.ProsodyScore,
    words: (nb.Words || []).map((w) => ({
      word: w.Word || "",
      score: (w.PronunciationAssessment || {}).AccuracyScore,
      error: (w.PronunciationAssessment || {}).ErrorType || "None",
      phonemes: (w.Phonemes || []).map((ph) => ({
        p: ph.Phoneme || "",
        score: (ph.PronunciationAssessment || {}).AccuracyScore,
      })),
    })),
  };
}

function assessWithSDK(wavBlob, refText) {
  return new Promise((resolve, reject) => {
    if (!state.azureKey) return reject(new Error("Azure 키가 설정되지 않았습니다. ⚙️ 설정에서 입력하세요."));
    if (typeof SpeechSDK === "undefined") return reject(new Error("Speech SDK 로드 실패 — 인터넷 연결을 확인하세요."));
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(state.azureKey, state.region);
    speechConfig.speechRecognitionLanguage = "en-US";
    const file = new File([wavBlob], "audio.wav", { type: "audio/wav" });
    const audioConfig = SpeechSDK.AudioConfig.fromWavFileInput(file);
    const pa = new SpeechSDK.PronunciationAssessmentConfig(
      refText,
      SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
      SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
      true // enableMiscue
    );
    pa.phonemeAlphabet = "IPA";
    pa.enableProsodyAssessment = true;
    const rec = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
    pa.applyTo(rec);
    rec.recognizeOnceAsync(
      (result) => {
        rec.close();
        if (result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
          try {
            const detail = JSON.parse(result.properties.getProperty(SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult));
            resolve(parseAzureDetail(detail));
          } catch (e) {
            reject(new Error("결과 해석 실패: " + e.message));
          }
        } else if (result.reason === SpeechSDK.ResultReason.NoMatch) {
          resolve({ ok: false, status: "InitialSilenceTimeout" });
        } else if (result.reason === SpeechSDK.ResultReason.Canceled) {
          const cd = SpeechSDK.CancellationDetails.fromResult(result);
          const msg = cd.errorDetails || String(cd.reason);
          reject(new Error(/401|Authentication|Forbidden/i.test(msg)
            ? "Azure 인증 실패 — 키/리전을 확인하세요."
            : "Azure 오류: " + msg.slice(0, 200)));
        } else {
          reject(new Error("채점 실패: " + result.reason));
        }
      },
      (err) => { rec.close(); reject(new Error("Azure 오류: " + String(err).slice(0, 200))); }
    );
  });
}

/* ---------- 녹음 & 채점 ---------- */
let recorder = null, recTimerId = null, recStart = 0;

async function toggleRecord() {
  if (state.recording) return stopAndAssess();

  const text = currentSentence().text;
  if (!text) { setStatus("먼저 문장을 선택/입력하세요"); return; }
  if (!state.azureKey) {
    setStatus("⚙️ 설정에서 Azure 키를 먼저 입력하세요");
    $("#modal").classList.remove("hidden");
    return;
  }
  try {
    recorder = new WavRecorder();
    await recorder.start((lv) => { $("#level").style.width = Math.round(lv * 100) + "%"; });
  } catch (e) {
    setStatus("❌ 마이크 접근 실패: " + e.message);
    return;
  }
  state.recording = true;
  $("#btnRec").classList.add("recording");
  $("#recTimer").classList.remove("hidden");
  setStatus("녹음 중... 문장을 읽고 버튼을 다시 누르세요");
  recStart = performance.now();
  recTimerId = setInterval(() => {
    const sec = (performance.now() - recStart) / 1000;
    $("#recTimer").textContent = sec.toFixed(1) + "s";
    if (sec >= MAX_REC_SEC) stopAndAssess();
  }, 100);
}

async function stopAndAssess() {
  clearInterval(recTimerId);
  state.recording = false;
  $("#btnRec").classList.remove("recording");
  $("#btnRec").classList.add("busy");
  $("#recTimer").classList.add("hidden");
  $("#level").style.width = "0%";
  setStatus("채점 중...");

  try {
    const wav = await recorder.stop();
    if (state.lastBlobUrl) URL.revokeObjectURL(state.lastBlobUrl);
    state.lastBlobUrl = URL.createObjectURL(wav);

    const text = currentSentence().text;
    const data = await assessWithSDK(wav, text);
    if (!data.ok) {
      setStatus(data.status === "InitialSilenceTimeout"
        ? "🔇 음성이 감지되지 않았습니다. 다시 시도하세요."
        : "채점 실패: " + data.status);
      return;
    }
    renderResult(data, text);
    saveHistory(data, text);
    updatePhonemeStats(data);
    if (data.pron != null) bumpDaily({ pron: data.pron });
    // 오답 복습이면 훈련 횟수 반영 (80점 이상 3회 → 졸업)
    const cur = currentSentence();
    if (cur.review) {
      const bank = getBank();
      const it = bank.find((b) => b.id === cur.review.id);
      if (it) {
        it.drill = (it.drill || 0) + 1;
        if (data.pron >= 80 && it.drill >= 3) it.grad = true;
        setBank(bank);
        renderBank();
        if (it.grad) setStatus(`🎓 "${it.right.slice(0, 30)}..." 졸업! 완전히 익혔습니다`);
        else setStatus(`완료! (이 문장 ${it.drill}회째 — 80점 이상 3회면 졸업)`);
        $("#answerText").classList.remove("hidden");
        return;
      }
    }
    setStatus("완료! 단어를 클릭하면 음소별 점수를 볼 수 있습니다");
  } catch (e) {
    setStatus("❌ " + e.message);
  } finally {
    $("#btnRec").classList.remove("busy");
  }
}

function setStatus(msg) { $("#recStatus").textContent = msg; }

/* ---------- 결과 렌더링 ---------- */
function scoreClass(v) { return v == null ? "" : v >= 80 ? "good" : v >= 60 ? "mid" : "bad"; }

function renderResult(data, refText) {
  const scores = $("#scores");
  scores.innerHTML = "";
  const items = [
    ["총점", data.pron, true],
    ["정확도", data.accuracy],
    ["유창성", data.fluency],
    ["억양", data.prosody],
    ["완성도", data.completeness],
  ];
  for (const [lbl, val, main] of items) {
    if (val == null) continue;
    const div = document.createElement("div");
    div.className = "score-chip" + (main ? " main" : "");
    div.innerHTML = `<div class="val c-${scoreClass(val)}">${Math.round(val)}</div><div class="lbl">${lbl}</div>`;
    scores.appendChild(div);
  }

  const box = $("#wordsBox");
  box.innerHTML = "";
  for (const w of data.words) {
    const span = document.createElement("span");
    span.textContent = w.word + " ";
    let cls = "w";
    if (w.error === "Omission") cls += " omit";
    else if (w.error === "Insertion") cls += " insert";
    else cls += " " + scoreClass(w.score);
    span.className = cls;
    if (w.phonemes && w.phonemes.length) {
      span.onclick = () => {
        document.querySelectorAll(".w.selected").forEach((el) => el.classList.remove("selected"));
        span.classList.add("selected");
        renderPhonemes(w);
      };
    }
    box.appendChild(span);
  }

  $("#phonemePanel").classList.add("hidden");
  $("#recognized").textContent = data.recognized ? "인식된 문장: " + data.recognized : "";
  $("#result").classList.remove("hidden");
  $("#result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderPhonemes(w) {
  const panel = $("#phonemePanel");
  const chips = w.phonemes.map((ph) =>
    `<div class="ph c-${scoreClass(ph.score)}">/${escapeHtml(ph.p)}/<span class="s">${ph.score == null ? "-" : Math.round(ph.score)}</span></div>`
  ).join("");
  panel.innerHTML = `<h3>"${escapeHtml(w.word)}" — 음소별 점수 (${w.error !== "None" ? w.error + ", " : ""}단어 ${w.score == null ? "-" : Math.round(w.score)}점)</h3><div class="ph-chips">${chips}</div>`;
  panel.classList.remove("hidden");
}

/* ---------- 기록 & 취약 음소 (localStorage) ---------- */
function saveHistory(data, text) {
  const hist = JSON.parse(localStorage.getItem("ec_history") || "[]");
  hist.unshift({
    d: new Date().toISOString().slice(0, 16).replace("T", " "),
    t: text,
    pron: data.pron, acc: data.accuracy, flu: data.fluency, pro: data.prosody,
  });
  localStorage.setItem("ec_history", JSON.stringify(hist.slice(0, 50)));
  renderHistory();
}

function renderHistory() {
  const hist = JSON.parse(localStorage.getItem("ec_history") || "[]");
  const el = $("#history");
  if (!hist.length) { el.textContent = "아직 기록이 없습니다."; return; }
  el.innerHTML = hist.slice(0, 8).map((h) =>
    `<div class="h-item"><span class="txt">${escapeHtml(h.t)}</span><span>${h.d.slice(5)}</span><span class="sc c-${scoreClass(h.pron)}">${h.pron == null ? "-" : Math.round(h.pron)}</span></div>`
  ).join("");
}

function updatePhonemeStats(data) {
  const stats = JSON.parse(localStorage.getItem("ec_phonemes") || "{}");
  for (const w of data.words) {
    if (w.error === "Omission") continue;
    for (const ph of w.phonemes || []) {
      if (ph.score == null || !ph.p) continue;
      const s = stats[ph.p] || { sum: 0, cnt: 0 };
      s.sum += ph.score; s.cnt += 1;
      stats[ph.p] = s;
    }
  }
  localStorage.setItem("ec_phonemes", JSON.stringify(stats));
  renderWeakPhonemes();
}

function renderWeakPhonemes() {
  const stats = JSON.parse(localStorage.getItem("ec_phonemes") || "{}");
  const rows = Object.entries(stats)
    .map(([p, s]) => ({ p, avg: s.sum / s.cnt, cnt: s.cnt }))
    .filter((r) => r.cnt >= 2 && r.avg < 85)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 8);
  const el = $("#weakPhonemes");
  if (!rows.length) { el.textContent = "아직 데이터가 없습니다. 문장을 채점하면 쌓입니다."; return; }
  el.innerHTML = rows.map((r) =>
    `<div class="weak-ph"><span class="sym c-${scoreClass(r.avg)}">/${escapeHtml(r.p)}/</span><span class="avg">평균 ${Math.round(r.avg)}점 · ${r.cnt}회</span></div>`
  ).join("");
}

/* ---------- 설정 (localStorage 우선, 로컬 서버에서 최초 이관) ---------- */
function maskKey(k) { return k.length > 8 ? k.slice(0, 4) + "…" + k.slice(-4) : "●●●●"; }

function applyConfig(cfg) {
  state.azureKey = cfg.azureKey || "";
  state.region = cfg.region || "koreacentral";
  state.geminiKey = cfg.geminiKey || "";
  $("#cfgRegion").value = state.region;
  $("#cfgKey").placeholder = state.azureKey ? "저장됨: " + maskKey(state.azureKey) : "Azure Speech 키";
  $("#cfgGemini").placeholder = state.geminiKey ? "저장됨 (변경 시에만 입력)" : "AIzaSy...";
  $("#keyBanner").classList.toggle("hidden", !!state.azureKey);
}

function loadConfig() {
  const cfg = JSON.parse(localStorage.getItem("ec_cfg") || "null");
  if (cfg) { applyConfig(cfg); return; }
  applyConfig({});
  // 로컬 서버(config.json)에서 1회 이관 — GitHub Pages에서는 조용히 실패
  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((s) => {
      const imported = { azureKey: s.azureKey || "", region: s.region || "koreacentral", geminiKey: s.geminiKey || "" };
      if (imported.azureKey || imported.geminiKey) {
        localStorage.setItem("ec_cfg", JSON.stringify(imported));
        applyConfig(imported);
      }
    })
    .catch(() => {});
}

function saveConfig() {
  const cfg = JSON.parse(localStorage.getItem("ec_cfg") || "{}");
  cfg.region = $("#cfgRegion").value;
  const k = $("#cfgKey").value.trim();
  if (k) cfg.azureKey = k;
  const g = $("#cfgGemini").value.trim();
  if (g) cfg.geminiKey = g;
  localStorage.setItem("ec_cfg", JSON.stringify(cfg));
  // 로컬 서버가 있으면 config.json에도 백업 (없으면 조용히 실패)
  fetch("/api/config", {
    method: "POST",
    body: JSON.stringify({ azure_key: k || undefined, azure_region: cfg.region, gemini_key: g || undefined }),
  }).catch(() => {});
  const st = $("#cfgStatus");
  st.textContent = "저장되었습니다 (이 기기에만 저장)";
  st.className = "cfg-status ok";
  $("#cfgKey").value = "";
  $("#cfgGemini").value = "";
  applyConfig(cfg);
}

async function testConfig() {
  const st = $("#cfgStatus");
  st.textContent = "테스트 중...";
  st.className = "cfg-status";
  const key = $("#cfgKey").value.trim() || state.azureKey;
  const region = $("#cfgRegion").value;
  if (!key) {
    st.textContent = "❌ Azure 키를 입력하세요";
    st.className = "cfg-status fail";
    return;
  }
  try {
    const r = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    if (r.ok) { st.textContent = "✅ 연결 성공"; st.className = "cfg-status ok"; }
    else {
      st.textContent = "❌ " + (r.status === 401 || r.status === 403 ? "키가 올바르지 않거나 리전이 다릅니다" : "HTTP " + r.status);
      st.className = "cfg-status fail";
    }
  } catch {
    st.textContent = "⚠️ 직접 테스트 불가 — 저장 후 채점을 시도해 확인하세요";
    st.className = "cfg-status";
  }
}

/* ================================================================
   💬 회화 수업 — Gemini Live API (브라우저 → WebSocket 직접 연결)
   ================================================================ */
const TOPICS = [
  { key: "free", label: "자유 대화", en: "free conversation — anything on the student's mind" },
  { key: "day", label: "오늘 하루", en: "how the student's day went" },
  { key: "travel", label: "여행", en: "travel experiences and plans" },
  { key: "hospital", label: "병원·검사실 상황", en: "workplace situations in a hospital clinical laboratory" },
  { key: "conference", label: "학회 스몰토크", en: "small talk at an international medical conference" },
  { key: "research", label: "내 연구 설명하기", en: "explaining the student's research in simple English" },
];

// ListModels(bidiGenerateContent 지원) 조회 결과 기준 (2026-07)
const LIVE_MODELS = [
  "gemini-2.5-flash-native-audio-latest",
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-preview-12-2025",
];

function personaPrompt(topicEn) {
  return `You are Emma, a friendly professional American English conversation teacher.
Your student is a Korean medical school professor with upper-intermediate English.
Rules:
- Speak only English, naturally and warmly, at a normal pace with clear articulation.
- Keep each turn SHORT (2-4 sentences) and end with a question. The student should talk more than you.
- When the student makes a grammar or word-choice mistake, briefly recast it naturally ("Oh, you mean ...") and move on. Never lecture.
- Occasionally teach ONE useful natural expression related to the topic.
- If the student is silent or struggling, encourage them and ask a simpler question.
Today's topic: ${topicEn}.
Start by greeting the student briefly and asking an easy opening question about the topic.`;
}

/* ---- 오디오 유틸 ---- */
function i16ToB64(i16) {
  const u8 = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToI16(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int16Array(u8.buffer);
}

/* ---- 24kHz PCM 재생기 (끼어들기 시 flush) ---- */
class PcmPlayer {
  constructor(rate) { this.rate = rate; this.ctx = null; this.next = 0; this.sources = []; }
  play(i16) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.rate });
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f.length, this.rate);
    buf.copyToChannel(f, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime, this.next);
    src.start(t);
    this.next = t + buf.duration;
    this.sources.push(src);
    src.onended = () => { this.sources = this.sources.filter((s) => s !== src); };
  }
  flush() {
    this.sources.forEach((s) => { try { s.stop(); } catch {} });
    this.sources = [];
    this.next = 0;
  }
  close() { this.flush(); if (this.ctx) { this.ctx.close(); this.ctx = null; } }
}

/* ---- 16kHz 마이크 스트리머 ---- */
class MicStreamer {
  async start(onChunk) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) {
        const s = Math.max(-1, Math.min(1, d[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onChunk(i16);
    };
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
  }
  stop() {
    try { this.proc.disconnect(); this.src.disconnect(); } catch {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
  }
}

/* ---- 수업 컨트롤러 ---- */
const conv = {
  ws: null, mic: null, player: null,
  connected: false, setupDone: false, intentional: false,
  topic: TOPICS[0], modelIdx: 0, failReasons: [],
  timerId: null, startAt: 0,
  transcript: [],           // [{role:'user'|'teacher', text}]
};

function convStatus(msg, cls) {
  const el = $("#convStatus");
  el.textContent = msg;
  el.className = "conv-status" + (cls ? " " + cls : "");
}

function renderTopics() {
  const box = $("#topics");
  box.innerHTML = "";
  for (const t of TOPICS) {
    const b = document.createElement("button");
    b.className = "tab" + (conv.topic.key === t.key ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => { if (!conv.connected) { conv.topic = t; renderTopics(); } };
    box.appendChild(b);
  }
}

function appendTranscript(role, fragment) {
  if (!fragment) return;
  const box = $("#transcript");
  const ph = box.querySelector(".placeholder");
  if (ph) ph.remove();
  const last = conv.transcript[conv.transcript.length - 1];
  if (last && last.role === role) {
    last.text += fragment;
    last.el.textContent = last.text;
  } else {
    const el = document.createElement("div");
    el.className = "bubble " + role;
    el.textContent = fragment;
    box.appendChild(el);
    conv.transcript.push({ role, text: fragment, el });
  }
  box.scrollTop = box.scrollHeight;
}

async function startLesson() {
  if (conv.connected) return stopLesson("수업을 마쳤습니다. 리포트를 만들 수 있어요.");
  if (!state.geminiKey) {
    $("#modal").classList.remove("hidden");
    $("#cfgStatus").textContent = "💬 회화 수업에는 Gemini 키가 필요합니다";
    $("#cfgStatus").className = "cfg-status fail";
    return;
  }
  conv.modelIdx = 0;
  conv.failReasons = [];
  conv.transcript = [];
  $("#transcript").innerHTML = "";
  $("#reportCard").classList.add("hidden");
  connectLive();
}

function connectLive() {
  const model = LIVE_MODELS[conv.modelIdx];
  convStatus(`연결 중... (${model.split("-").slice(0, 3).join("-")})`, "wait");
  $("#btnConnect").disabled = true;
  conv.setupDone = false;
  conv.intentional = false;

  const ws = new WebSocket(
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key="
    + encodeURIComponent(state.geminiKey)
  );
  conv.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      setup: {
        model: "models/" + model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
        systemInstruction: { parts: [{ text: personaPrompt(conv.topic.en) }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  };

  ws.onmessage = async (ev) => {
    const raw = ev.data instanceof Blob ? await ev.data.text() : ev.data;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.setupComplete !== undefined) {
      conv.setupDone = true;
      await beginStreaming();
      // 선생님이 먼저 인사하도록 트리거
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "(The lesson starts now. Greet me and begin.)" }] }],
          turnComplete: true,
        },
      }));
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) { conv.player && conv.player.flush(); return; }
    if (sc.inputTranscription) appendTranscript("user", sc.inputTranscription.text);
    if (sc.outputTranscription) appendTranscript("teacher", sc.outputTranscription.text);
    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) conv.player.play(b64ToI16(p.inlineData.data));
    }
  };

  ws.onclose = (ev) => {
    if (conv.intentional) { conv.intentional = false; return; } // 사용자가 직접 종료 → 이미 정리됨
    if (!conv.setupDone) {
      // 모델 미지원 등으로 setup 실패 → 다음 모델로 재시도
      conv.failReasons.push(model + " → " + (ev.reason || "code " + ev.code));
      if (conv.modelIdx < LIVE_MODELS.length - 1) {
        conv.modelIdx += 1;
        connectLive();
      } else {
        $("#btnConnect").disabled = false;
        convStatus("연결 실패:\n" + conv.failReasons.join("\n"), "fail");
      }
      return;
    }
    // 서버 측 종료 (무료 티어 세션 시간 만료 등)
    endLessonCleanup();
    convStatus("수업 종료됨 — 📋 버튼으로 리포트를 만들 수 있어요", "");
  };

  ws.onerror = () => { /* onclose에서 처리 */ };
}

async function beginStreaming() {
  conv.player = new PcmPlayer(24000);
  conv.mic = new MicStreamer();
  try {
    await conv.mic.start((i16) => {
      if (conv.ws && conv.ws.readyState === WebSocket.OPEN) {
        conv.ws.send(JSON.stringify({
          realtimeInput: { audio: { data: i16ToB64(i16), mimeType: "audio/pcm;rate=16000" } },
        }));
      }
    });
  } catch (e) {
    convStatus("❌ 마이크 접근 실패: " + e.message, "fail");
    stopLesson();
    return;
  }
  conv.connected = true;
  conv.startAt = Date.now();
  $("#btnConnect").disabled = false;
  $("#btnConnect").textContent = "⏹ 수업 마치기";
  $("#btnEndReport").disabled = false;
  convStatus("🟢 수업 중 — 편하게 말씀하세요", "live");
  $("#convTimer").classList.remove("hidden");
  conv.timerId = setInterval(() => {
    const s = Math.floor((Date.now() - conv.startAt) / 1000);
    $("#convTimer").textContent =
      String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}

function endLessonCleanup() {
  // 수업 시간 기록 (10초 이상만)
  if (conv.connected && conv.startAt) {
    const sec = Math.round((Date.now() - conv.startAt) / 1000);
    if (sec >= 10) {
      const sessions = JSON.parse(localStorage.getItem("ec_sessions") || "[]");
      sessions.unshift({
        d: new Date().toISOString().slice(0, 16).replace("T", " "),
        topic: conv.topic.label,
        sec,
      });
      localStorage.setItem("ec_sessions", JSON.stringify(sessions.slice(0, 50)));
      bumpDaily({ convSec: sec });
    }
    conv.startAt = 0;
  }
  if (conv.mic) { conv.mic.stop(); conv.mic = null; }
  if (conv.player) { conv.player.close(); conv.player = null; }
  clearInterval(conv.timerId);
  conv.connected = false;
  conv.setupDone = false;
  $("#btnConnect").disabled = false;
  $("#btnConnect").textContent = "🎧 수업 시작";
  $("#convTimer").classList.add("hidden");
}

function stopLesson(statusMsg) {
  if (conv.ws && conv.ws.readyState <= WebSocket.OPEN) {
    conv.intentional = true; // onclose에서 재시도하지 않도록 표시
    try { conv.ws.close(); } catch {}
  }
  endLessonCleanup();
  convStatus(statusMsg || "대기 중", "");
}

/* ---- 수업 종료 리포트 (Gemini REST, 무료 티어, 혼잡 시 모델 폴백) ---- */
async function makeReport() {
  const turns = conv.transcript.map((t) => (t.role === "user" ? "Student: " : "Teacher: ") + t.text).join("\n");
  if (!turns.trim()) { convStatus("리포트를 만들 대화 내용이 없습니다", "fail"); return; }
  if (conv.connected) stopLesson("수업 종료 — 리포트 생성 중...");
  $("#btnEndReport").disabled = true;
  $("#reportCard").classList.remove("hidden");
  $("#reportBody").textContent = "리포트 생성 중...";

  const prompt = `다음은 한국인 학습자(Student)와 영어 선생님(Teacher)의 영어 회화 수업 대화록입니다.
학습자의 영어를 분석해서 아래 JSON 형식으로만 응답하세요:

{
  "report": "한국어 마크다운 리포트. 형식: ## 교정이 필요한 문장 (3~5개)\\n- ❌ 원문 → ✅ 자연스러운 표현 — 이유 한 줄\\n## 잘한 표현 (1~2개)\\n## 다음 수업 연습 포인트 (1개)",
  "corrections": [
    {"wrong": "학습자가 말한 원문 그대로", "right": "자연스러운 완전한 문장", "reason": "교정 이유 한 줄 (한국어)"}
  ]
}

corrections는 report의 교정 문장과 동일한 3~5개. right는 발음 연습용이므로 완전한 한 문장으로.

대화록:
${turns}`;

  const REPORT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
  try {
    let data = null, lastErr = "리포트 생성 실패";
    for (const m of REPORT_MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=`
        + encodeURIComponent(state.geminiKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        }
      );
      const body = await res.json();
      if (res.ok) { data = body; break; }
      lastErr = (body.error && body.error.message) || lastErr;
      // 과부하/한도 초과(429, 503)면 다음 모델로, 그 외(키 오류 등)는 즉시 중단
      if (res.status !== 429 && res.status !== 503) break;
      $("#reportBody").textContent = `모델 혼잡 — 다른 모델로 재시도 중 (${m} → 다음)...`;
    }
    if (!data) throw new Error(lastErr + " (잠시 후 📋 버튼을 다시 눌러주세요 — 대화록은 유지됩니다)");
    const raw = data.candidates[0].content.parts.map((p) => p.text || "").join("");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* JSON 실패 시 원문 그대로 표시 */ }
    const reportMd = (parsed && parsed.report) ? parsed.report : raw;
    let html = reportMd
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\n/g, "<br>");
    // 교정 문장 → 오답 은행 자동 저장
    const added = parsed ? addToBank(parsed.corrections, conv.topic.label) : 0;
    if (added > 0) {
      html += `<p class="bank-note">🗂 오답 은행에 ${added}문장 추가됨 — 🔤 발음 연습의 <b>오답 복습</b> 탭에서 "고쳐 말하기" 훈련을 해보세요!</p>`;
    }
    $("#reportBody").innerHTML = html;
    const reports = JSON.parse(localStorage.getItem("ec_reports") || "[]");
    reports.unshift({ d: new Date().toISOString().slice(0, 16).replace("T", " "), topic: conv.topic.label, report: reportMd });
    localStorage.setItem("ec_reports", JSON.stringify(reports.slice(0, 20)));
  } catch (e) {
    $("#reportBody").textContent = "❌ " + e.message;
  } finally {
    $("#btnEndReport").disabled = false;
  }
}

/* ---- 모드 전환 ---- */
function switchMode(mode) {
  $("#viewPron").classList.toggle("hidden", mode !== "pron");
  $("#viewConv").classList.toggle("hidden", mode !== "conv");
  $("#viewDash").classList.toggle("hidden", mode !== "dash");
  $("#modePron").classList.toggle("active", mode === "pron");
  $("#modeConv").classList.toggle("active", mode === "conv");
  $("#modeDash").classList.toggle("active", mode === "dash");
  if (mode === "dash") renderDash();
}

/* ================================================================
   📊 대시보드
   ================================================================ */
function fmtDuration(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + "시간 " + Math.round((sec % 3600) / 60) + "분";
  if (sec >= 60) return Math.round(sec / 60) + "분";
  return sec + "초";
}

function calcStreak(daily) {
  let streak = 0;
  const day = new Date();
  // 오늘 기록이 없으면 어제부터 센다
  if (!daily[day.toISOString().slice(0, 10)]) day.setDate(day.getDate() - 1);
  while (daily[day.toISOString().slice(0, 10)]) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

function renderDash() {
  const daily = JSON.parse(localStorage.getItem("ec_daily") || "{}");
  const sessions = JSON.parse(localStorage.getItem("ec_sessions") || "[]");
  const bank = getBank();

  // ── 요약 타일
  let totalN = 0, totalSum = 0, totalConv = 0;
  for (const d of Object.values(daily)) {
    totalN += d.n || 0;
    totalSum += d.pronSum || 0;
    totalConv += d.convSec || 0;
  }
  const tiles = [
    { v: totalN, l: "발음 채점 횟수" },
    { v: totalN ? Math.round(totalSum / totalN) : "-", l: "평균 총점" },
    { v: fmtDuration(totalConv), l: "누적 수업 시간" },
    { v: calcStreak(daily) + "일", l: "연속 학습" },
  ];
  $("#dashTiles").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="tile-v">${t.v}</div><div class="tile-l">${t.l}</div></div>`
  ).join("");

  // ── 최근 14일 일평균 점수 막대 차트 (SVG)
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const k = dt.toISOString().slice(0, 10);
    const d = daily[k];
    days.push({
      label: (dt.getMonth() + 1) + "/" + dt.getDate(),
      avg: d && d.n ? Math.round(d.pronSum / d.n) : null,
    });
  }
  if (days.every((d) => d.avg == null)) {
    $("#dashChart").innerHTML = `<p class="dash-empty">아직 채점 기록이 없습니다.</p>`;
  } else {
    const W = 700, H = 190, padL = 34, padB = 24, padT = 14;
    const bw = (W - padL - 10) / 14;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 14일 일평균 발음 점수">`;
    // 그리드 (0/50/100) — 눈에 띄지 않게
    for (const gv of [0, 50, 100]) {
      const y = padT + (H - padT - padB) * (1 - gv / 100);
      svg += `<line x1="${padL}" y1="${y}" x2="${W - 6}" y2="${y}" stroke="#33405e" stroke-width="1"/>`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#8b95ab">${gv}</text>`;
    }
    days.forEach((d, i) => {
      const x = padL + i * bw + bw * 0.22;
      if (d.avg != null) {
        const h = (H - padT - padB) * (d.avg / 100);
        const y = H - padB - h;
        svg += `<rect x="${x}" y="${y}" width="${bw * 0.56}" height="${Math.max(h, 2)}" rx="3" fill="#4f8cff"><title>${d.label} — 평균 ${d.avg}점</title></rect>`;
        svg += `<text x="${x + bw * 0.28}" y="${y - 5}" text-anchor="middle" font-size="11" fill="#e8ecf5">${d.avg}</text>`;
      }
      if (i % 2 === 1) {
        svg += `<text x="${x + bw * 0.28}" y="${H - 7}" text-anchor="middle" font-size="10.5" fill="#8b95ab">${d.label}</text>`;
      }
    });
    svg += "</svg>";
    $("#dashChart").innerHTML = svg;
  }

  // ── 취약 음소 순위 (가로 막대)
  const stats = JSON.parse(localStorage.getItem("ec_phonemes") || "{}");
  const rows = Object.entries(stats)
    .map(([p, s]) => ({ p, avg: Math.round(s.sum / s.cnt), cnt: s.cnt }))
    .filter((r) => r.cnt >= 2)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 8);
  $("#dashPhonemes").innerHTML = rows.length
    ? rows.map((r) =>
        `<div class="ph-row">
           <span class="ph-sym">/${escapeHtml(r.p)}/</span>
           <div class="ph-track"><div class="ph-fill ${scoreClass(r.avg)}" style="width:${r.avg}%"></div></div>
           <span class="ph-val">${r.avg}점 · ${r.cnt}회</span>
         </div>`
      ).join("")
    : `<p class="dash-empty">아직 데이터가 없습니다.</p>`;

  // ── 오답 은행 진행률
  const grad = bank.filter((b) => b.grad).length;
  const pct = bank.length ? Math.round((grad / bank.length) * 100) : 0;
  $("#dashBank").innerHTML = bank.length
    ? `<div class="bank-progress">
         <div class="ph-track big"><div class="ph-fill good" style="width:${pct}%"></div></div>
         <span>🎓 ${grad} / ${bank.length} 문장 졸업 (${pct}%)</span>
       </div>`
    : `<p class="dash-empty">오답 은행이 비어 있습니다.</p>`;

  // ── 최근 수업
  $("#dashSessions").innerHTML = sessions.length
    ? sessions.slice(0, 6).map((s) =>
        `<div class="h-item"><span class="txt">${escapeHtml(s.topic)}</span><span>${s.d.slice(5)}</span><span class="sc">${fmtDuration(s.sec)}</span></div>`
      ).join("")
    : `<p class="dash-empty">아직 수업 기록이 없습니다.</p>`;
}

/* ---------- 초기화 ---------- */
function init() {
  renderTabs();
  renderSentence();
  renderHistory();
  renderWeakPhonemes();
  renderBank();
  loadConfig();
  $("#btnShowAnswer").onclick = () => $("#answerText").classList.toggle("hidden");

  $("#btnRec").onclick = toggleRecord;
  $("#btnListen").onclick = playModel;
  $("#btnNext").onclick = () => { state.idx += 1; renderSentence(); };
  $("#btnRetry").onclick = () => { $("#result").classList.add("hidden"); toggleRecord(); };
  $("#btnPlayback").onclick = () => { if (state.lastBlobUrl) new Audio(state.lastBlobUrl).play(); };
  $("#customApply").onclick = () => {
    state.customSentence = $("#customText").value.trim().replace(/\s+/g, " ");
    renderSentence();
  };
  $("#btnSettings").onclick = () => $("#modal").classList.remove("hidden");
  $("#bannerOpen").onclick = () => $("#modal").classList.remove("hidden");
  $("#cfgClose").onclick = () => $("#modal").classList.add("hidden");
  $("#cfgSave").onclick = saveConfig;
  $("#cfgTest").onclick = testConfig;
  $("#modal").onclick = (e) => { if (e.target === $("#modal")) $("#modal").classList.add("hidden"); };

  // 회화 수업
  renderTopics();
  $("#modePron").onclick = () => switchMode("pron");
  $("#modeConv").onclick = () => switchMode("conv");
  $("#modeDash").onclick = () => switchMode("dash");
  $("#btnConnect").onclick = startLesson;
  $("#btnEndReport").onclick = makeReport;
  window.addEventListener("beforeunload", () => { if (conv.connected) stopLesson(); });
}

init();
