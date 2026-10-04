/* AetherDrive safety check-in timer.
   Every N minutes the app asks "Are you okay?". No answer means nearby drivers are alerted.
   Load this after main.js: it uses main.js's getPosition, submitReport, triggerSOS and beep. */
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const REPLY_SECONDS = 20, SNOOZE_MIN = 5;

  let running = false, endAt = 0, totalMs = 0, intervalMs = 0, tickTimer = null, replyTimer = null;

  const status = (msg) => { el("ciStatus").textContent = msg; };
  const setApp = (level, text) => window.AetherDrive?.setStatus(level, text);
  const pad = (n) => String(n).padStart(2, "0");
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  function render() {
    const left = endAt - Date.now(), d = el("ciDisplay");
    d.textContent = running ? fmt(left) : "--:--";
    d.classList.toggle("is-running", running);
    d.classList.toggle("is-low", running && left < Math.min(60000, totalMs / 4));
    el("ciBar").style.width = running ? `${Math.max(0, (left / totalMs) * 100)}%` : "0%";
  }

  function schedule(ms) {
    totalMs = ms; endAt = Date.now() + ms;
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { render(); if (Date.now() >= endAt) ask(); }, 500);
    render();
  }

  function alertUser() {
    window.beep?.();
    navigator.vibrate?.([200, 100, 200]);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("AetherDrive safety check-in", { body: "Are you okay? Open the app to respond." });
    }
  }

  function closeDialog() {
    clearInterval(replyTimer); replyTimer = null;
    if (el("ciDialog").open) el("ciDialog").close();
  }

  function start() {
    intervalMs = parseFloat(el("ciInterval").value) * 60000;
    running = true; schedule(intervalMs);
    el("ciStart").textContent = "Stop check-ins";
    status("Check-ins are on. If you don't answer a check-in, nearby drivers are alerted.");
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }

  function stop(msg = "Check-ins are off.") {
    running = false; clearInterval(tickTimer); closeDialog(); render();
    el("ciStart").textContent = "Start check-ins";
    status(msg);
  }

  function ask() {
    if (!running) return;
    // A crash check or another check-in is already on screen: try again shortly.
    if (el("safetyDialog")?.open || el("ciDialog").open) { endAt = Date.now() + 30000; return; }
    clearInterval(tickTimer);
    let left = REPLY_SECONDS;
    el("ciCount").textContent = left;
    el("ciDialog").showModal();
    setApp("warn", "Safety check-in. Are you okay?");
    alertUser();
    replyTimer = setInterval(() => {
      el("ciCount").textContent = --left;
      if (left % 4 === 0 && left > 0) alertUser();
      if (left <= 0) missed();
    }, 1000);
  }

  async function missed() {
    closeDialog(); stop("Check-in missed.");
    setApp("danger", "No response to the safety check-in.");
    try {
      const pos = await getPosition(true);
      await submitReport("sos", "Driver missed a safety check-in.", pos);
      status(`No response. Nearby AetherDrive users have been alerted. Your location: https://www.google.com/maps?q=${pos.lat},${pos.lng}`);
    } catch {
      status("No response, and your location is unavailable. Call 112 if you need help.");
    }
  }

  el("ciStart").addEventListener("click", () => (running ? stop() : start()));
  el("ciOk").addEventListener("click", () => {
    closeDialog(); setApp("ok", "Driver alert. All clear.");
    schedule(intervalMs);
    status(`Thanks. Next check-in in ${fmt(intervalMs)}.`);
  });
  el("ciSnooze").addEventListener("click", () => {
    closeDialog(); setApp("ok", "Driver alert. All clear.");
    schedule(SNOOZE_MIN * 60000);
    status(`Snoozed. Next check-in in ${SNOOZE_MIN} minutes.`);
  });
  el("ciHelp").addEventListener("click", () => { stop("SOS started."); window.triggerSOS?.(); });
  el("ciDialog").addEventListener("cancel", (e) => e.preventDefault());
  render();
})();