/* Shared gear-icon settings popup, present on every page. Controls the CRT
 * flicker's schedule: on at load for a stretch, then quiet, then a random
 * chance to flash again on a fixed cadence. Every number is editable in the
 * modal and persists via localStorage across the whole site (all pages
 * share one origin, subpaths included).
 */
(() => {
  "use strict";
  const KEY = "crt-flicker-settings";
  const LEGACY_KEY = "crt-flicker-disabled";
  const DEFAULTS = { enabled: true, initialSec: 30, cycleSec: 60, chancePct: 50, burstSec: 10 };

  let cfg = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved) cfg = { ...DEFAULTS, ...saved };
    else {
      // Migrate the old plain on/off flag if that's all that's there.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy === "1") cfg.enabled = false;
    }
  } catch (e) {}

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function setFlicker(on) { document.body.classList.toggle("no-flicker", !on); }

  let initialTimer = null, cycleInterval = null, burstOffTimer = null;
  function stopSchedule() {
    clearTimeout(initialTimer); initialTimer = null;
    clearInterval(cycleInterval); cycleInterval = null;
    clearTimeout(burstOffTimer); burstOffTimer = null;
  }
  function startSchedule() {
    stopSchedule();
    if (!cfg.enabled) { setFlicker(false); return; }
    setFlicker(true);
    initialTimer = setTimeout(() => {
      setFlicker(false);
      cycleInterval = setInterval(() => {
        clearTimeout(burstOffTimer);
        if (Math.random() * 100 < cfg.chancePct) {
          setFlicker(true);
          burstOffTimer = setTimeout(() => setFlicker(false), Math.max(0, cfg.burstSec) * 1000);
        }
      }, Math.max(1, cfg.cycleSec) * 1000);
    }, Math.max(0, cfg.initialSec) * 1000);
  }
  startSchedule();

  // Deuteranomaly mode: swaps the site's red "bad" signal for blue, since
  // red-green color blindness is what makes red vs. green hardest to tell
  // apart in the first place.
  const DEUTAN_KEY = "deuteranomaly-mode";
  let deutan = false;
  try { deutan = localStorage.getItem(DEUTAN_KEY) === "1"; } catch (e) {}
  document.body.classList.toggle("deuteranomaly", deutan);

  const btn = document.getElementById("settings-btn");
  if (!btn) return;

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay hidden";
  overlay.innerHTML = `
    <div class="settings-panel">
      <button type="button" class="settings-close" aria-label="Close">✕</button>
      <h2>SETTINGS</h2>
      <label class="settings-row">
        <input type="checkbox" id="flicker-toggle">
        <span>Enable CRT flickering</span>
      </label>
      <p class="settings-desc">Flicker for
        <input type="text" id="flicker-initial" class="settings-num" inputmode="numeric"> sec on load, then every
        <input type="text" id="flicker-cycle" class="settings-num" inputmode="numeric"> sec there's a
        <input type="text" id="flicker-chance" class="settings-num" inputmode="numeric">% chance it flickers again for
        <input type="text" id="flicker-burst" class="settings-num" inputmode="numeric"> sec.
      </p>
      <label class="settings-row" style="margin-top:14px">
        <input type="checkbox" id="deutan-toggle">
        <span>Deuteranomaly mode (swap red for blue)</span>
      </label>
    </div>`;
  document.body.appendChild(overlay);

  const toggle = overlay.querySelector("#flicker-toggle");
  const fInitial = overlay.querySelector("#flicker-initial");
  const fCycle = overlay.querySelector("#flicker-cycle");
  const fChance = overlay.querySelector("#flicker-chance");
  const fBurst = overlay.querySelector("#flicker-burst");
  const deutanToggle = overlay.querySelector("#deutan-toggle");

  function syncFields() {
    toggle.checked = cfg.enabled;
    fInitial.value = cfg.initialSec;
    fCycle.value = cfg.cycleSec;
    fChance.value = cfg.chancePct;
    fBurst.value = cfg.burstSec;
    deutanToggle.checked = deutan;
  }
  syncFields();

  const open = () => overlay.classList.remove("hidden");
  const close = () => overlay.classList.add("hidden");

  btn.addEventListener("click", open);
  overlay.querySelector(".settings-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  toggle.addEventListener("change", () => {
    cfg.enabled = toggle.checked;
    save();
    startSchedule();
  });

  const numField = (input, key, min, max) => {
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      cfg[key] = isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAULTS[key];
      syncFields();
      save();
      startSchedule();
    });
  };
  numField(fInitial, "initialSec", 0, 3600);
  numField(fCycle, "cycleSec", 1, 3600);
  numField(fChance, "chancePct", 0, 100);
  numField(fBurst, "burstSec", 0, 3600);

  deutanToggle.addEventListener("change", () => {
    deutan = deutanToggle.checked;
    document.body.classList.toggle("deuteranomaly", deutan);
    try { localStorage.setItem(DEUTAN_KEY, deutan ? "1" : "0"); } catch (e) {}
  });
})();
