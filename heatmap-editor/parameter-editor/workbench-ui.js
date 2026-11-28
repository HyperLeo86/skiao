import {statuses} from "./parameter-model.js";

const icons = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  library: '<rect x="4" y="4" width="15" height="16" rx="2"/><path d="M8 4v16m3-11h5m-5 4h5"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15 15 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  number: '<path d="m10 4-3 16m10-16-3 16M4 9h16M3 15h16"/>',
  choice: '<path d="M10 6h10m-10 6h10m-10 6h10M4 6h1m-1 6h1m-1 6h1"/>',
  project: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
  text: '<path d="M4 5h16m-8 0v14m-4 0h8M4 5v3m16-3v3"/>',
  edit: '<path d="M13 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7m-9 3 1-4 7-7 3 3-7 7-4 1Z"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  form: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10v4m3-2h5"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13m-7 4v5m4-5v5"/>',
};
const icon = (name, size = 17) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const $ = id => document.getElementById(id);
const btn = (action, title, extra = "", glyph = "") => `<button type="button" class="btn ${extra}" data-action="${action}">${glyph ? icon(glyph, 16) : ""}${title}</button>`;
const statusBadge = status => `<span class="status ${status}"><i></i>${statuses[status]}</span>`;
const selected = (value, expected) => value === expected ? " selected" : "";
const checked = value => value ? " checked" : "";
const pairs = entries => Object.entries(entries);
const opt = (items, value) => items.map(([code, label]) =>
  `<option value="${esc(code)}"${selected(String(value ?? ""), String(code))}>${esc(label)}</option>`).join("");

function input(path, value, {type = "text", label, placeholder = "", code = false} = {}) {
  return `<input data-bind="${path}" ${label ? `aria-label="${esc(label)}"` : ""} type="${type}" value="${esc(value)}"
    placeholder="${esc(placeholder)}" ${type === "number" ? 'step="any"' : 'autocomplete="off"'} ${code ? 'class="mono" spellcheck="false"' : ""}>`;
}
function select(path, value, options, label = "") {
  return `<select data-bind="${path}" ${label ? `aria-label="${esc(label)}"` : ""}>${opt(options, value)}</select>`;
}
function labeled(label, control, required = false) {
  return `<label class="field"><span>${label}${required ? ' <em>*</em>' : ''}</span>${control}</label>`;
}
function block(title, body, info = "") {
  return `<section class="definition-block"><div class="block-title"><h3>${title}</h3>${info ? `<span>${info}</span>` : ""}</div>${body}</section>`;
}
function checklist(options, values, target, empty) {
  return options.length ? `<div class="checklist">${options.map(([code, name]) =>
    `<label class="checkbox"><input type="checkbox" data-${target} value="${esc(code)}"${checked(values?.includes(code))}> ${esc(name)}</label>`).join("")}</div>` :
    `<span class="hint">${empty}</span>`;
}

function colorJson(value) {
  const tokens = value.split(/("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/gi);
  return tokens.map((part, index) => !part ? "" : index % 4 === 1 ? `<span class="${valueForKey(index) ? "json-key" : "json-string"}">${esc(part)}</span>` :
      index % 4 === 3 ? `<span class="json-literal">${esc(part)}</span>` : esc(part)).join("");

  function valueForKey(index) {
    return tokens[index + 1]?.includes(":");
  }
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename, rows) {
  const cell = value => {
    let text = String(value ?? "");
    if (/^[\t\r\n]|^\s*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const csv = rows.map(row => row.map(cell).join(",")).join("\r\n");
  download(filename, "\uFEFF" + csv, "text/csv;charset=utf-8");
}

function toggleValue(values, value, on) {
  return on ? [...new Set([...(values || []), value])] : (values || []).filter(item => item !== value);
}

export {icon, esc, $, btn, statusBadge, checked, pairs, opt, input, select, labeled, block, checklist, colorJson, download, downloadCsv, toggleValue};
