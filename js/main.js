"use strict";
/* AetherDrive front-end logic.
   Works on its own in demo mode. When server.js is running, photo diagnosis,
   follow-up chat and shared alerts switch to real data automatically. */

const CONFIG = {
  defaultCenter: { lat: 28.6139, lng: 77.209 }, // only used for demo data if location is blocked
  sosHoldMs: 2000,
  crashCountdown: 15,
  crashThreshold: 35,      // m/s² (about 3.5 g) on the phone's motion sensor
  alertPollMs: 8000,
};

const $ = (id) => document.getElementById(id);
const state = {
  pos: null, photo: null, map: null, markers: [], centres: [], demoCentres: false,
  alerts: [], alertsLoaded: false, mapsReady: false, chat: [], lastDiagnosis: null,
  pollTimer: null, stream: null, lastRest: 0,
};

/* ---------- Helpers ---------- */
const say = (el, msg) => { el.textContent = msg; };
const mapsLink = (p) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;
const dirLink = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

function distKm(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const fmtDist = (km) => (km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} m` : `${km.toFixed(1)} km`);
function timeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setStatus(level, text) {
  $("statusDot").className = `dot dot-${level}`;
  say($("statusText"), text);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "square"; osc.frequency.value = 880; gain.gain.value = 0.05;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch { /* sound is optional */ }
}

async function shareText(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(text); return "copied"; } catch { return "failed"; }
}

function getPosition(fresh = false) {
  if (state.pos && !fresh) return Promise.resolve(state.pos);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location isn't supported on this device."));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const first = !state.pos;
        state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (first) startAlertPolling();
        resolve(state.pos);
      },
      () => reject(new Error("Location is blocked. Allow location access in your browser and try again.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: fresh ? 0 : 60000 }
    );
  });
}

/* ---------- Google Maps hooks (index.html loads the API with callback=initMap) ---------- */
window.initMap = () => { state.mapsReady = true; };
window.gm_authFailure = () => { state.mapsReady = false; console.warn("Google Maps key rejected. Using demo data."); };

function ensureMap() {
  if (!state.mapsReady || !window.google?.maps) return null;
  if (!state.map) {
    $("map").innerHTML = "";
    state.map = new google.maps.Map($("map"), { center: state.pos, zoom: 13, disableDefaultUI: true, zoomControl: true });
  }
  return state.map;
}

/* ---------- Photo upload and AI diagnosis ---------- */
function fileToJpeg(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Couldn't read that image. Try a JPG or PNG."));
    img.src = url;
  });
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return say($("analyzeStatus"), "That file isn't an image. Choose a JPG or PNG.");
  try {
    state.photo = await fileToJpeg(file);
    $("photoPreview").src = state.photo;
    $("previewWrap").hidden = false;
    $("dropzone").hidden = true;
    $("analyzeBtn").disabled = false;
    say($("analyzeStatus"), "Photo ready. Press Analyze photo.");
  } catch (e) { say($("analyzeStatus"), e.message); }
}

function clearPhoto() {
  state.photo = null;
  $("photoInput").value = ""; $("photoCamera").value = "";
  $("previewWrap").hidden = true; $("dropzone").hidden = false;
  $("analyzeBtn").disabled = true;
  say($("analyzeStatus"), "Add a photo to begin.");
}

function demoDiagnosis() {
  return {
    demo: true,
    problem: "Dashboard warning light (demo result)",
    urgency: "medium",
    explanation: "The AI server isn't connected, so this is a placeholder. Run server.js with your Anthropic key to get a real diagnosis of your photo.",
    steps: ["Pull over somewhere safe and switch off the engine.", "Check your owner's manual for the symbol shown.", "Call roadside assistance if the car feels unsafe to drive."],
  };
}

function renderDiagnosis(d) {
  state.lastDiagnosis = d;
  const level = ["low", "medium", "high"].includes(d.urgency) ? d.urgency : "medium";
  say($("vProblem"), d.problem || "Diagnosis");
  $("vUrgency").className = `badge ${level}`;
  say($("vUrgency"), `${level.charAt(0).toUpperCase() + level.slice(1)} urgency`);
  say($("vExplain"), d.explanation || "");
  const steps = Array.isArray(d.steps) ? d.steps : String(d.steps || "").split(/\n+/).filter(Boolean);
  $("vSteps").replaceChildren(...steps.map((s) => Object.assign(document.createElement("li"), { textContent: s })));
  $("resultEmpty").hidden = true; $("resultBody").hidden = false;
  state.chat = [];
  $("chatLog").replaceChildren();
}

async function analyze() {
  if (!state.photo) return;
  const btn = $("analyzeBtn");
  btn.disabled = true; say($("analyzeStatus"), "Analyzing your photo…");
  try {
    let data;
    try {
      data = await api("/api/diagnose", { method: "POST", body: JSON.stringify({
        image: state.photo.split(",")[1], mediaType: "image/jpeg",
        carModel: $("carModel").value, description: $("describe").value.trim(),
      }) });
    } catch { data = demoDiagnosis(); }
    renderDiagnosis(data);
    say($("analyzeStatus"), data.demo ? "Showing a demo result. The AI server isn't running." : "Done.");
    $("resultPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally { btn.disabled = false; }
}

function addChat(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "msg-user" : "msg-ai"}`;
  div.textContent = text;
  $("chatLog").appendChild(div);
  div.scrollIntoView({ block: "nearest" });
}

async function askFollowup() {
  const q = $("followupInput").value.trim();
  if (!q) return;
  $("followupInput").value = "";
  addChat("user", q); state.chat.push({ role: "user", content: q });
  let reply;
  try {
    ({ reply } = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages: state.chat, diagnosis: state.lastDiagnosis }) }));
  } catch { reply = "The AI server isn't connected, so I can't answer yet. Run server.js to turn this on. If the car feels unsafe, call roadside assistance."; }
  addChat("ai", reply); state.chat.push({ role: "assistant", content: reply });
}

async function shareDiagnosis() {
  const d = state.lastDiagnosis; if (!d) return;
  const text = `AetherDrive diagnosis: ${d.problem} (${d.urgency} urgency). ${d.explanation || ""}`;
  const r = await shareText(text, "AetherDrive diagnosis");
  say($("analyzeStatus"), r === "copied" ? "Diagnosis copied to your clipboard." : r === "shared" ? "Diagnosis shared." : "");
}

/* ---------- Suzuki service centres ---------- */
const QUERIES = {
  all: "Maruti Suzuki service centre", service: "Maruti Suzuki authorised service centre",
  arena: "Maruti Suzuki Arena showroom", nexa: "Nexa showroom",
};

async function searchPlaces(type, radius) {
  const { Place } = await google.maps.importLibrary("places");
  const { places } = await Place.searchByText({
    textQuery: QUERIES[type],
    fields: ["displayName", "location", "formattedAddress", "nationalPhoneNumber", "regularOpeningHours", "utcOffsetMinutes", "googleMapsURI"],
    locationBias: { center: state.pos, radius }, maxResultCount: 20,
  });
  return Promise.all(places.map(async (p) => {
    let open = null; try { open = await p.isOpen(); } catch { /* hours unknown */ }
    return { name: p.displayName, address: p.formattedAddress, phone: p.nationalPhoneNumber, open, lat: p.location.lat(), lng: p.location.lng() };
  }));
}

function demoCentres() {
  const c = state.pos || CONFIG.defaultCenter;
  return [
    { name: "Sample Suzuki Service Centre A", address: "Demo data. Add a Google Maps key for real results.", dLat: .012, dLng: .008, open: true },
    { name: "Sample Nexa Showroom", address: "Demo data.", dLat: -.02, dLng: .015, open: true },
    { name: "Sample Arena Showroom", address: "Demo data.", dLat: .03, dLng: -.02, open: false },
  ].map((s) => ({ ...s, lat: c.lat + s.dLat, lng: c.lng + s.dLng }));
}

async function loadCentres() {
  $("centreList").innerHTML = '<li class="empty">Searching for Suzuki centres…</li>';
  const radius = +$("centreRadius").value;
  let list = null;
  if (state.mapsReady) { try { list = await searchPlaces($("centreType").value, radius); } catch (e) { console.warn(e); } }
  state.demoCentres = !list;
  state.centres = (list || demoCentres())
    .map((c) => ({ ...c, km: distKm(state.pos, c) }))
    .filter((c) => state.demoCentres || c.km <= radius / 1000 + 1)
    .sort((a, b) => a.km - b.km);
  renderCentres();
}

function renderCentres() {
  const ul = $("centreList"), onlyOpen = $("openNow").checked;
  const shown = state.centres.filter((c) => !onlyOpen || c.open === true);
  state.markers.forEach((m) => m.setMap(null)); state.markers = [];
  if (!shown.length) {
    ul.innerHTML = '<li class="empty">No Suzuki centres found. Try a larger radius or a different type.</li>';
    return say($("nearestShort"), "None found");
  }
  const map = ensureMap(), bounds = map && new google.maps.LatLngBounds();
  ul.replaceChildren(...shown.map((c) => {
    const li = $("centreTemplate").content.firstElementChild.cloneNode(true);
    li.querySelector(".centre-name").textContent = c.name;
    li.querySelector(".centre-meta").textContent =
      `${fmtDist(c.km)} away${c.open === true ? " · Open now" : c.open === false ? " · Closed" : ""}${c.address ? " · " + c.address : ""}`;
    const call = li.querySelector(".centre-call");
    c.phone ? (call.href = `tel:${c.phone.replace(/\s/g, "")}`) : call.remove();
    li.querySelector(".centre-directions").href = dirLink(c);
    li.querySelector(".centre-book").addEventListener("click", () =>
      say($("actionReadout"), `Booking request noted for ${c.name}. (Prototype: connect Suzuki's booking system here.)`));
    if (map) {
      const m = new google.maps.Marker({ position: c, map, title: c.name });
      state.markers.push(m); bounds.extend(c);
    }
    return li;
  }));
  if (map) { bounds.extend(state.pos); map.fitBounds(bounds, 50); }
  say($("nearestShort"), `${fmtDist(shown[0].km)} away`);
}

async function useLocation() {
  try {
    say($("actionReadout"), "Finding your location…");
    await getPosition(true);
    say($("actionReadout"), "");
    if (state.mapsReady) { ensureMap(); new google.maps.Marker({ position: state.pos, map: state.map, title: "You are here" }); }
    await loadCentres();
  } catch (e) { say($("actionReadout"), e.message); $("centreList").innerHTML = `<li class="empty">${e.message}</li>`; }
}

/* ---------- Accident alerts ---------- */
const ALERT_LABEL = {
  accident: "Accident reported", breakdown: "Broken-down vehicle", hazard: "Road hazard",
  flood: "Flooding or poor visibility", sos: "Driver sent an SOS", crash: "Possible crash, driver not responding",
};
const ALERT_SHORT = { accident: "Accident", breakdown: "Breakdown", hazard: "Hazard", flood: "Weather", sos: "SOS", crash: "Crash" };

function mergeAlerts(list, announce) {
  const known = new Set(state.alerts.map((a) => a.id)), fresh = [];
  list.forEach((a) => { if (!known.has(a.id)) { state.alerts.push(a); fresh.push(a.id); } });
  if (announce && fresh.length && state.alertsLoaded && $("alertSound").checked) beep();
  return fresh;
}

function seedDemoAlerts() {
  const c = state.pos; if (!c) return;
  mergeAlerts([
    { id: "demo-1", type: "accident", note: "Two vehicles on the left lane.", lat: c.lat + .01, lng: c.lng + .006, time: Date.now() - 6 * 60000, demo: true },
    { id: "demo-2", type: "hazard", note: "Large pothole near the flyover.", lat: c.lat - .02, lng: c.lng + .01, time: Date.now() - 22 * 60000, demo: true },
  ], false);
}

function renderAlerts(freshIds = []) {
  const ul = $("alertList"), radius = +$("alertRadius").value;
  const near = state.alerts
    .map((a) => ({ ...a, km: state.pos ? distKm(state.pos, a) : 0 }))
    .filter((a) => a.km <= radius).sort((a, b) => b.time - a.time);
  say($("alertCount"), `${near.length} active`);
  if (!near.length) {
    ul.innerHTML = '<li class="empty">No incidents reported nearby. You\'ll see new alerts here as they come in.</li>';
    return;
  }
  ul.replaceChildren(...near.map((a) => {
    const li = $("alertTemplate").content.firstElementChild.cloneNode(true);
    if (freshIds.includes(a.id)) li.classList.add("is-new");
    li.querySelector(".alert-type").textContent = ALERT_SHORT[a.type] || "Alert";
    li.querySelector(".alert-title").textContent = ALERT_LABEL[a.type] || "Incident";
    li.querySelector(".alert-meta").textContent =
      `${fmtDist(a.km)} away · ${timeAgo(a.time)}${a.note ? " · " + a.note : ""}${a.demo ? " · Demo data" : ""}`;
    li.querySelector(".alert-route").href = mapsLink(a);
    return li;
  }));
}

async function pollAlerts() {
  if (!state.pos) return;
  let fresh = [];
  try {
    const data = await api(`/api/alerts?lat=${state.pos.lat}&lng=${state.pos.lng}&radius=${$("alertRadius").value}`);
    fresh = mergeAlerts(data, true);
  } catch { if (!state.alerts.length) seedDemoAlerts(); }
  state.alertsLoaded = true;
  renderAlerts(fresh);
}

function startAlertPolling() {
  if (state.pollTimer) return;
  pollAlerts();
  state.pollTimer = setInterval(pollAlerts, CONFIG.alertPollMs);
}

async function submitReport(type, note, pos) {
  let alert;
  try {
    alert = await api("/api/alerts", { method: "POST", body: JSON.stringify({ type, note, lat: pos.lat, lng: pos.lng }) });
  } catch { alert = { id: `local-${Date.now()}`, type, note, lat: pos.lat, lng: pos.lng, time: Date.now() }; }
  renderAlerts(mergeAlerts([alert], false));
}

async function reportIncident() {
  const status = $("reportStatus");
  try {
    say(status, "Getting your location…");
    const pos = await getPosition(true);
    await submitReport($("incidentType").value, $("incidentNote").value.trim(), pos);
    $("incidentNote").value = "";
    say(status, "Alert sent to nearby drivers.");
  } catch (e) { say(status, e.message); }
}

/* ---------- Crash check ---------- */
let crashTimer = null, motionOn = false, lastCrash = 0;

function startCrashCheck(reason) {
  const dlg = $("safetyDialog");
  if (dlg.open) return;
  let left = CONFIG.crashCountdown;
  say($("countdown"), left);
  say($("crashReadout"), reason);
  setStatus("danger", "Impact detected. Checking on you.");
  dlg.showModal();
  crashTimer = setInterval(() => {
    say($("countdown"), --left);
    if (left <= 0) { endCrashCheck(); crashNoResponse(); }
  }, 1000);
}

function endCrashCheck() {
  clearInterval(crashTimer); crashTimer = null;
  if ($("safetyDialog").open) $("safetyDialog").close();
}

async function crashNoResponse() {
  try {
    const pos = await getPosition(true);
    await submitReport("crash", "Driver did not respond to the safety check.", pos);
    say($("crashReadout"), "No response. Nearby AetherDrive users have been alerted.");
  } catch { say($("crashReadout"), "No response, but your location is unavailable. Call 112 if you need help."); }
}

async function enableMotion() {
  if (motionOn || !window.DeviceMotionEvent) return;
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    try { if ((await DeviceMotionEvent.requestPermission()) !== "granted") return; } catch { return; }
  }
  motionOn = true;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity; if (!a) return;
    const g = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    if (g > CONFIG.crashThreshold && Date.now() - lastCrash > 30000) {
      lastCrash = Date.now();
      startCrashCheck("Sudden impact detected by your phone's motion sensor.");
    }
  });
}

/* ---------- SOS and quick actions ---------- */
async function triggerSOS() {
  const out = $("sosReadout");
  setStatus("danger", "SOS triggered");
  let pos = null;
  try { pos = await getPosition(true); } catch (e) { say(out, `${e.message} Call 112 now.`); }
  if (pos) submitReport("sos", "SOS pressed by the driver.", pos);
  const text = `SOS from AetherDrive. I need help. My location: ${pos ? mapsLink(pos) : "unavailable"}`;
  const r = await shareText(text, "AetherDrive SOS");
  say(out, {
    shared: "SOS message shared with your contacts. Call 112 if you are in danger.",
    copied: "SOS message copied. Paste it to your emergency contacts and call 112 if you are in danger.",
    cancelled: "SOS message not sent. Call 112 if you need help.",
    failed: "Couldn't share automatically. Call 112 now.",
  }[r]);
}

function bindSOS() {
  const btn = $("sosBtn"); let raf = null, start = 0;
  const cancel = () => { if (raf) cancelAnimationFrame(raf); raf = null; btn.style.setProperty("--hold", 0); };
  const tick = (t) => {
    const pct = Math.min(100, ((t - start) / CONFIG.sosHoldMs) * 100);
    btn.style.setProperty("--hold", pct);
    if (pct >= 100) { cancel(); triggerSOS(); } else raf = requestAnimationFrame(tick);
  };
  const begin = () => { if (raf) return; start = performance.now(); say($("sosReadout"), "Keep holding…"); raf = requestAnimationFrame(tick); };
  const stop = () => { if (raf) say($("sosReadout"), ""); cancel(); };
  btn.addEventListener("pointerdown", begin);
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); begin(); } });
  btn.addEventListener("keyup", stop);
}

async function shareLocation() {
  try {
    say($("actionReadout"), "Getting your location…");
    const pos = await getPosition(true);
    const r = await shareText(`My live location: ${mapsLink(pos)}`, "My location");
    say($("actionReadout"), r === "shared" ? "Location shared." : r === "copied" ? "Location link copied. Paste it into a message." : r === "cancelled" ? "" : "Couldn't share. Copy this link: " + mapsLink(pos));
  } catch (e) { say($("actionReadout"), e.message); }
}

/* ---------- Drowsiness camera (MediaPipe plugs in here next) ---------- */
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 }, audio: false });
    $("cam").srcObject = state.stream;
    $("startCam").disabled = true; $("stopCam").disabled = false;
    say($("drowsyReadout"), "Camera is on. Drowsiness detection arrives with MediaPipe in the next step.");
  } catch { say($("drowsyReadout"), "Couldn't open the camera. Allow camera access, and use localhost or HTTPS."); }
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null; $("cam").srcObject = null;
  $("startCam").disabled = false; $("stopCam").disabled = true;
  say($("drowsyReadout"), "Camera is off.");
  $("restSuggestion").hidden = true;
}

async function suggestRestStop() {
  let pos; try { pos = await getPosition(); } catch { return; }
  let stop = null;
  if (state.mapsReady) {
    try {
      const { Place } = await google.maps.importLibrary("places");
      const { places } = await Place.searchByText({
        textQuery: "rest area or petrol pump with cafe", fields: ["displayName", "location"],
        locationBias: { center: pos, radius: 10000 }, maxResultCount: 1,
      });
      if (places[0]) stop = { name: places[0].displayName, lat: places[0].location.lat(), lng: places[0].location.lng() };
    } catch (e) { console.warn(e); }
  }
  say($("restName"), stop ? stop.name : "a safe place to pull over");
  $("restRoute").href = stop ? dirLink(stop) : `https://www.google.com/maps/search/rest+area/@${pos.lat},${pos.lng},14z`;
  $("restSuggestion").hidden = false;
}

/* Call this from the MediaPipe code with a 0-100 alertness score. */
function setAlertness(pct) {
  $("alertMeter").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (pct >= 70) setStatus("ok", "Driver alert. All clear.");
  else if (pct >= 40) setStatus("warn", "Alertness is dropping.");
  else {
    setStatus("danger", "Drowsiness detected. Take a break.");
    if (Date.now() - state.lastRest > 120000) { state.lastRest = Date.now(); suggestRestStop(); }
  }
}
window.AetherDrive = { setAlertness, setStatus, suggestRestStop };

/* ---------- Wire everything up ---------- */
document.addEventListener("DOMContentLoaded", () => {
  // photo
  $("photoInput").addEventListener("change", (e) => handleFile(e.target.files[0]));
  $("photoCamera").addEventListener("change", (e) => handleFile(e.target.files[0]));
  $("removePhoto").addEventListener("click", clearPhoto);
  $("analyzeBtn").addEventListener("click", analyze);
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-over"); }));
  dz.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  $("followupBtn").addEventListener("click", askFollowup);
  $("followupInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askFollowup(); } });
  $("shareDiagnosis").addEventListener("click", shareDiagnosis);

  // service centres
  $("useLocation").addEventListener("click", useLocation);
  $("centreType").addEventListener("change", () => state.pos && loadCentres());
  $("centreRadius").addEventListener("change", () => state.pos && loadCentres());
  $("openNow").addEventListener("change", () => state.centres.length && renderCentres());
  $("bookService").addEventListener("click", () => {
    $("service").scrollIntoView({ behavior: "smooth" });
    say($("actionReadout"), "Pick a centre below and press Book service.");
  });

  // alerts
  $("reportBtn").addEventListener("click", reportIncident);
  $("alertRadius").addEventListener("change", () => { renderAlerts(); pollAlerts(); });

  // crash, SOS, actions
  $("simulateCrash").addEventListener("click", async () => { await enableMotion(); startCrashCheck("Simulated impact."); });
  $("imOkay").addEventListener("click", () => { endCrashCheck(); setStatus("ok", "Driver alert. All clear."); say($("crashReadout"), "Marked safe. No alert sent."); });
  $("needHelp").addEventListener("click", () => { endCrashCheck(); triggerSOS(); });
  $("safetyDialog").addEventListener("cancel", (e) => e.preventDefault());
  $("shareLocation").addEventListener("click", shareLocation);
  bindSOS();

  // camera
  $("startCam").addEventListener("click", startCamera);
  $("stopCam").addEventListener("click", stopCamera);

  // Android and desktop allow motion sensing without a tap. iOS asks on "Simulate impact".
  if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission !== "function") enableMotion();
});