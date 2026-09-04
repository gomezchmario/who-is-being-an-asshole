/* Shared gear-icon settings popup, present on every page. One toggle so
 * far: CRT flicker on/off. Persists via localStorage across the whole
 * site (all pages share one origin, subpaths included).
 */
(() => {
  "use strict";
  const KEY = "crt-flicker-disabled";
  let disabled = false;
  try { disabled = localStorage.getItem(KEY) === "1"; } catch (e) {}
  if (disabled) document.body.classList.add("no-flicker");

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
    </div>`;
  document.body.appendChild(overlay);

  const toggle = overlay.querySelector("#flicker-toggle");
  toggle.checked = !disabled;

  const open = () => overlay.classList.remove("hidden");
  const close = () => overlay.classList.add("hidden");

  btn.addEventListener("click", open);
  overlay.querySelector(".settings-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  toggle.addEventListener("change", () => {
    document.body.classList.toggle("no-flicker", !toggle.checked);
    try { localStorage.setItem(KEY, toggle.checked ? "0" : "1"); } catch (e) {}
  });
})();
