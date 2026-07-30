const DATA_URL = "data/violations.json";
const DEFAULT_VIEW_LIMIT = 40;

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const qEl = document.getElementById("q");
const minUnitsEl = document.getElementById("min-units");
const maxUnitsEl = document.getElementById("max-units");


const ISSUE_CATEGORIES = [
  { id: "mice", pattern: /\bmice\b/i },
  { id: "rats", pattern: /\brats?\b/i },
  { id: "mold", pattern: /\bmold\b/i },
  { id: "no-heat", pattern: /\b(heat|hot water)\b/i },
  { id: "roaches", pattern: /\broaches?\b/i },
  { id: "fire-damage", pattern: /fire damage/i },
  { id: "lead-paint", pattern: /\blead\b/i },
];
const ALL_ISSUE_IDS = [...ISSUE_CATEGORIES.map((c) => c.id), "other"];

document.querySelectorAll(".f-issue").forEach((cb) => { cb.checked = true; });
let selectedIssues = new Set(
  Array.from(document.querySelectorAll(".f-issue:checked")).map((el) => el.value)
);

function issueNote() {
  if (selectedIssues.size === ALL_ISSUE_IDS.length) return "";
  return selectedIssues.size ? ` · issue ${[...selectedIssues].join("/")}` : " · no issue selected";
}

function violationMatchesIssues(v) {
  const matched = ISSUE_CATEGORIES.filter((c) => c.pattern.test(v.description));
  if (!matched.length) return selectedIssues.has("other");
  return matched.some((c) => selectedIssues.has(c.id));
}

let buildings = [];

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

const minDateEl = document.getElementById("min-date");
const maxDateEl = document.getElementById("max-date");

function getDateBounds() {
  const min = minDateEl.value.trim() || null;
  const max = maxDateEl.value.trim() || null;
  return { min, max };
}

function matchesDateRange(approvedDate) {
  const { min, max } = getDateBounds();
  if (min == null && max == null) return true;
  const d = approvedDate.slice(0, 10);
  if (min != null && d < min) return false;
  if (max != null && d > max) return false;
  return true;
}

function dateRangeNote() {
  const { min, max } = getDateBounds();
  if (min == null && max == null) return "";
  return ` · ${min ?? "any"}–${max ?? "any"}`;
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

document.querySelectorAll(".f-boro").forEach((cb) => {
  cb.checked = true;
});
let selectedBoros = new Set(
  Array.from(document.querySelectorAll(".f-boro:checked")).map((el) => el.value)
);

function boroNote() {
  if (selectedBoros.size === 5) return "";
  return selectedBoros.size ? ` · ${[...selectedBoros].join("/")}` : " · no borough selected";
}

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

    renderResults();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "couldn't load violations. try refresh."
  }
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
    const viols = apt.violations.filter(
      (v) =>
        selectedClasses.has(v.class) &&
        matchesDateRange(v.approved_date) &&
        violationMatchesIssues(v)
    );
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


function matchesAddressQuery(address) {
  const q = qEl.value.trim().toLowerCase();
  return !q || address.toLowerCase().includes(q);
}

function renderResults() {
  const entries = [];
  for (const b of buildings) {
    if (!matchesUnitRange(b.unit_count)) continue;
    if (!selectedBoros.has(b.boro)) continue;
    if (!matchesAddressQuery(b.address)) continue;
    const { apartments, count, density } = filteredBuildingView(b);
    if (count === 0) continue;
    entries.push({
      bbl: b.bbl, address: b.address, boro: b.boro, unit_count: b.unit_count,
      bin: b.bin, apartments, hazard_apartment_count: count, hazard_density_score: density,
    });
  }

  const top = rankBuildings(entries, DEFAULT_VIEW_LIMIT);
  const q = qEl.value.trim();
  const matchNote = q ? ` matching "${escapeHtml(q)}"` : "";

  statusEl.textContent = entries.length
    ? `${entries.length.toLocaleString()} buildings${matchNote} — showing highest violations-per-unit first.`
    : `No buildings match the current filters${matchNote}.`;

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

let debounceTimer;
qEl.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderResults(), 150);
});

[minUnitsEl, maxUnitsEl].forEach((el) => {
  el.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(), 150);
  });
});

[minDateEl, maxDateEl].forEach((el) => {
  el.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(), 150);
  });
});

document.querySelectorAll(".f-class").forEach((cb) => {
  cb.addEventListener("change", () => {
    selectedClasses = new Set(
      Array.from(document.querySelectorAll(".f-class:checked")).map((el) => el.value)
    );
    renderResults();
  });
});

document.querySelectorAll(".f-issue").forEach((cb) => {
  cb.addEventListener("change", () => {
    selectedIssues = new Set(
      Array.from(document.querySelectorAll(".f-issue:checked")).map((el) => el.value)
    );
    renderResults();
  });
});

document.querySelectorAll(".f-boro").forEach((cb) => {
  cb.addEventListener("change", () => {
    selectedBoros = new Set(
      Array.from(document.querySelectorAll(".f-boro:checked")).map((el) => el.value)
    );
    renderResults();
  });
});

document.querySelectorAll(".hint button").forEach((btn) => {
  btn.addEventListener("click", () => {
    qEl.value = btn.dataset.q;
    qEl.focus();
    renderResults();
  });
});



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
