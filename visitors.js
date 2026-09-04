/* Small visitor count in the footer, fed by GoatCounter's public counter API.
 * Fails silently if the endpoint isn't reachable or public stats are off.
 */
(() => {
  fetch("https://xhq7v.goatcounter.com/counter/TOTAL.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d?.count) return;
      const el = document.getElementById("visitors");
      if (el) el.textContent = " · " + String(d.count).trim() + " capsuleers surveilled";
    })
    .catch(() => {});
})();
