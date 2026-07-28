const DATA_URL = "data/violations.json";
const DEFAULT_VIEW_LIMIT = 40;
const SEARCH_RESULT_LIMIT = 60;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const qEl = document.getElementById("q");
const minUnitsEl = document.getElementById("min-units");
const maxUnitsEl = document.getElementById("max-units");

let buildings = [];
let flatRecords = []; // one entry per violation, carrying its parent building info
let fuse = null;

function getUnitBounds() {
  const minRaw = minUnitsEl.value.trim();
  const maxRaw = maxUnitsEl.value.trim();
  const min = minRaw === "" ? null : Number(minRaw);
  const max = maxRaw === "" ? null : Number(maxRaw);
  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  };
}


function matchesUnitRange(unitCount) {
  const { min, max } = getUnitBounds();
  if (min == null && max == null) return true;
  if (unitCount == null || unitCount === 0) return false;
  if (min != null && unitCount < min) return false;
  if (max != null && unitCount > max) return false;
  return true;
}

function unitRangeNote() {
  const { min, max } = getUnitBounds();
  if (min == null && max == null) return "";
  return ` · ${min ?? 0}–${max ?? "∞"} units`;
}

document.querySelectorAll(".f-class").forEach((cb) => {
  cb.checked = true;
});
let selectedClasses = new Set(
  Array.from(document.querySelectorAll(".f-class:checked")).map((el) => el.value)
);

function classNote() {
  const sorted = [...selectedClasses].sort();
  if (sorted.length === 3) return "";
  return sorted.length ? ` · class ${sorted.join("/")}` : " · no class selected";
}

init();

async function init() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    buildings = data.buildings || [];
    document.getElementById("gen-date").textContent = formatGeneratedDate(data.generated_at);

    flatRecords = flatten(buildings);
    fuse = new Fuse(flatRecords, {
      keys: [
        { name: "description", weight: 0.6 },
        { name: "address", weight: 0.25 },
        { name: "apartment", weight: 0.15 },
      ],
      threshold: 0.32,
      ignoreLocation: true,
      minMatchCharLength: 2,
      includeMatches: true,
    });

    renderDefault();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't load violations data. Try refreshing.";
  }
}

function flatten(buildings) {
  const out = [];
  for (const b of buildings) {
    for (const apt of b.apartments) {
      for (const v of apt.violations) {
        out.push({
          bbl: b.bbl,
          address: b.address,
          boro: b.boro,
          unit_count: b.unit_count,
          bin: b.bin,
          apartment: apt.apartment,
          violation_id: v.violation_id,
          class: v.class,
          approved_date: v.approved_date,
          description: v.description,
        });
      }
    }
  }
  return out;
}

function formatGeneratedDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatDensity(b) {
  if (b.hazard_density_score == null) {
    return `${b.hazard_apartment_count} apt${b.hazard_apartment_count === 1 ? "" : "s"} affected (unit count unknown)`;
  }
  const pct = Math.round(b.hazard_density_score * 100);
  return `${b.hazard_apartment_count} of ${b.unit_count} unit${b.unit_count === 1 ? "" : "s"} affected (<b>${pct}%</b>)`;
}

function filteredBuildingView(b) {
  const apartments = [];
  for (const apt of b.apartments) {
    const viols = apt.violations.filter((v) => selectedClasses.has(v.class));
    if (viols.length) apartments.push({ apartment: apt.apartment, violations: viols });
  }
  const count = apartments.length;
  const density = b.unit_count != null && b.unit_count > 0 ? count / b.unit_count : null;
  return { apartments, count, density };
}

function rankBuildings(candidates, limit) {
  const preFiltered = [...candidates]
    .sort((a, b) => b.hazard_apartment_count - a.hazard_apartment_count)
    .slice(0, limit * 3);

  preFiltered.sort((a, b) => {
    const ad = a.hazard_density_score ?? -1;
    const bd = b.hazard_density_score ?? -1;
    return bd - ad;
  });

  return preFiltered.slice(0, limit);
}

function renderDefault() {
  const entries = [];
  for (const b of buildings) {
    if (!matchesUnitRange(b.unit_count)) continue;
    const { apartments, count, density } = filteredBuildingView(b);
    if (count === 0) continue;
    entries.push({
      bbl: b.bbl,
      address: b.address,
      boro: b.boro,
      unit_count: b.unit_count,
      bin: b.bin,
      apartments,
      hazard_apartment_count: count,
      hazard_density_score: density,
    });
  }

  const top = rankBuildings(entries, DEFAULT_VIEW_LIMIT);

  statusEl.textContent = entries.length
    ? `${entries.length.toLocaleString()} buildings${unitRangeNote()}${classNote()} — showing highest violations-per-unit first.`
    : `No buildings match the current filters${unitRangeNote()}${classNote()}.`;

  resultsEl.innerHTML = top.map((b) => buildingCard(b, b.apartments)).join("");
}

function buildingCard(b, apartments, matchedViolationIds) {
  const aptsHtml = apartments
    .map((apt) => {
      const viols = apt.violations
        .filter((v) => !matchedViolationIds || matchedViolationIds.has(v.violation_id))
        .slice(0, 6)
        .map(
          (v) => `
        <div class="viol">
          <span class="viol-tag">[${v.class}]</span>
          <span class="viol-apt">Apt ${escapeHtml(apt.apartment)}</span>${escapeHtml(v.description)}
        </div>`
        )
        .join("");
      return viols;
    })
    .join("");

  const addressHtml = `<a href="${buildJustFixUrl(b.boro, b.address)}" target="_blank" rel="noopener">${escapeHtml(b.address)}</a>`;

  return `
    <details class="card" data-bbl="${escapeHtml(b.bbl)}">
      <summary class="card-top">
        <span class="address">${addressHtml}</span>
        <span class="meta">${escapeHtml(b.boro)}</span>
      </summary>
      <div class="density">${formatDensity(b)}</div>
      <div class="viol-list">${aptsHtml}</div>
    </details>`;
}

function buildJustFixUrl(boro, address) {
  const parts = address.trim().split(/\s+/);
  const houseNumber = parts[0] ?? "";
  const streetName = parts.slice(1).join(" ").toUpperCase();
  return `https://whoownswhat.justfix.org/en/address/${encodeURIComponent(boro)}/${encodeURIComponent(houseNumber)}/${encodeURIComponent(streetName)}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function highlightQuery(text, query) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return escapeHtml(text);

  const escapedWords = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escapedWords.join("|")})`, "gi");

  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    result += `<mark>${escapeHtml(match[0])}</mark>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function runSearch(query) {
  if (!query.trim()) {
    renderDefault();
    return;
  }

  const hits = searchRecords(query)
    .filter((hit) => matchesUnitRange(hit.item.unit_count) && selectedClasses.has(hit.item.class));

  if (!hits.length) {
    statusEl.textContent = `No matches for "${query}"${unitRangeNote()}${classNote()}.`;
    resultsEl.innerHTML = `<div class="empty">No violations matched "${escapeHtml(query)}" with the current filters. Try a broader term or fewer filters.</div>`;
    return;
  }

  // Group matching violation records back up by building, keeping only
  // the apartments/violations that actually matched. Highlighting is
  // computed separately from the raw query (see highlightQuery), not
  // from Fuse's match indices.
  const byBbl = new Map();
  for (const hit of hits) {
    const rec = hit.item;
    if (!byBbl.has(rec.bbl)) {
      byBbl.set(rec.bbl, {
        bbl: rec.bbl,
        address: rec.address,
        boro: rec.boro,
        unit_count: rec.unit_count,
        bin: rec.bin,
        apartments: new Map(),
      });
    }
    const entry = byBbl.get(rec.bbl);
    if (!entry.apartments.has(rec.apartment)) entry.apartments.set(rec.apartment, []);
    entry.apartments.get(rec.apartment).push({
      violation_id: rec.violation_id,
      class: rec.class,
      description: rec.description,
    });
  }

  const candidates = Array.from(byBbl.values()).map((entry) => {
    const count = entry.apartments.size;
    const density = entry.unit_count != null && entry.unit_count > 0 ? count / entry.unit_count : null;
    return { ...entry, hazard_apartment_count: count, hazard_density_score: density };
  });

  const grouped = rankBuildings(candidates, SEARCH_RESULT_LIMIT);

  if (!grouped.length) {
    statusEl.textContent = `No matches for "${query}".`;
    resultsEl.innerHTML = `<div class="empty">No violations matched "${escapeHtml(query)}". Try a broader term.</div>`;
    return;
  }

  statusEl.textContent = `${grouped.length} building${grouped.length === 1 ? "" : "s"} matching "${query}"${unitRangeNote()}${classNote()} (of ${buildings.length.toLocaleString()} total).`;

  resultsEl.innerHTML = grouped
    .map((building) => {
      const aptsHtml = Array.from(building.apartments.entries())
        .map(
          ([apt, viols]) => viols
            .map(
              (v) => `
          <div class="viol">
            <span class="viol-tag">[${v.class}]</span>
            <span class="viol-apt">Apt ${escapeHtml(apt)}</span>${highlightQuery(v.description, query)}
          </div>`
            )
            .join("")
        )
        .join("");

      return `
      <details class="card" data-bbl="${escapeHtml(building.bbl)}">
        <summary class="card-top">
          <span class="address"><a href="${buildJustFixUrl(building.boro, building.address)}" target="_blank" rel="noopener">${escapeHtml(building.address)}</a></span>
          <span class="meta">${escapeHtml(building.boro)}</span>
        </summary>
        <div class="density">${formatDensity(building)}</div>
        <div class="viol-list">${aptsHtml}</div>
      </details>`;
    })
    .join("");
}

let debounceTimer;
qEl.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(qEl.value), 150);
});

[minUnitsEl, maxUnitsEl].forEach((el) => {
  el.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(qEl.value), 150);
  });
});

document.querySelectorAll(".f-class").forEach((cb) => {
  cb.addEventListener("change", () => {
    selectedClasses = new Set(
      Array.from(document.querySelectorAll(".f-class:checked")).map((el) => el.value)
    );
    runSearch(qEl.value);
  });
});

document.querySelectorAll(".hint button").forEach((btn) => {
  btn.addEventListener("click", () => {
    qEl.value = btn.dataset.q;
    qEl.focus();
    runSearch(qEl.value);
  });
});

function searchRecords(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return flatRecords
    .filter(
      (r) =>
        r.description.toLowerCase().includes(q) ||
        r.address.toLowerCase().includes(q) ||
        r.apartment.toLowerCase().includes(q)
    )
    .map((item) => ({ item }));
}

resultsEl.addEventListener(
  "toggle",
  (e) => {
    if (!(e.target instanceof HTMLDetailsElement) || !e.target.open) return;
    resultsEl.querySelectorAll("details.card[open]").forEach((d) => {
      if (d !== e.target) d.open = false;
    });
  },
  true
);
