// Loads the pre-generated violations.json once, then does all
// filtering/searching client-side. No backend involved.

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

// A unit_count of 0 isn't a real building size (see the comment in
// annotateHazardCounts below) — treat it the same as "unknown" so a
// "0–5 units" search doesn't surface SRO/hotel records with a fabricated
// zero. When no range is set at all, every building passes, same as before.
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

// Which violation classes count at all. Defaults to A/B/C, matching the
// original CLI's class prompt — unchecking all of them means "show
// nothing" (an explicit user choice), not "ignore the filter."
//
// Browsers sometimes restore checkbox states from a previous visit on a
// plain reload, overriding the HTML's declared "checked" default. Force
// the intended default here, then read the filter state FROM the actual
// checkboxes — so the visible checkboxes and this script's filtering
// logic can never silently disagree with each other.
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
    document.getElementById("days-back").textContent = data.days_back ?? "30";
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

// Returns only the apartments (and, within them, only the violations)
// whose class is currently selected, plus the resulting count/density.
// Recomputed on every render rather than cached, since the class filter
// can change at any time — this is what keeps the density percentage and
// the actual displayed violation list in agreement with each other.
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

// Replicates the original CLI's make_summary() exactly: sort candidates by
// raw apartment count first, keep only the top (limit * 3), then re-sort
// that narrowed set by density. Ties at the density stage just inherit
// their relative order from the raw-count sort (stable sort) — same as
// the original, no separate tiebreak rule needed.
//
// One deliberate deviation: unit_count of 0/unknown sorts to the bottom
// (via hazard_density_score being null) instead of being used as a literal
// denominator. The original CLI divided by it directly, which for real
// SRO/rooming-house PLUTO records (unitsres = 0) produces a divide-by-zero
// and an effectively infinite, meaningless percentage — a bug, not
// something worth reproducing.
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

// JustFix's "Who Owns What" needs the address split into house number and
// street name, both uppercase, with the borough — e.g.
// https://whoownswhat.justfix.org/en/address/BROOKLYN/753/MAC%20DONOUGH%20STREET
// Our stored `address` is "753 Mac Donough Street" (capitalized for
// display), so split on the first space to recover the house number and
// re-uppercase the rest for the street name.
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

// Highlights the literal words the person typed, wherever they appear as
// real contiguous text — deliberately NOT using Fuse's fuzzy match indices,
// which reflect scattered characters that contributed to its approximate
// scoring rather than a clean substring a human would recognize.
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

  const hits = fuse
    .search(query, { limit: SEARCH_RESULT_LIMIT * 3 })
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

  // The density shown must reflect only the apartments that matched THIS
  // search — not the building's overall hazard stats — or the percentage
  // in the header won't agree with the violation list underneath it.
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

// Only one building's violation list open at a time. The 'toggle' event
// doesn't bubble, but a capture-phase listener on an ancestor still catches
// it on the way down — so one listener here works for every card, including
// ones added later by re-renders, since resultsEl itself is never replaced.
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
