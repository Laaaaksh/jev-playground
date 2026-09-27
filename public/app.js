const CRITERIA_HELP = {
  choice: ["Options (one per line: name: what it means)", "Jev picks exactly one. Add a \"none\" option if nothing may fit."],
  score: ["Levels (one per line, lowest first)", "Each level should describe a concrete situation that makes sense on its own."],
  noul: ["Optional: define yes/no (true: … and false: …)", "Returns the probability that the answer is yes. Leave empty for a plain yes/no."],
};

const EXAMPLE = {
  state: "Hi, I was charged twice for my annual plan this morning and I need one of the charges refunded today. This is really frustrating.",
  questions: [
    { id: "category", type: "choice", instructions: "What is this support message mainly about?",
      criteria: "billing: payments, charges, refunds, invoices\ntechnical: bugs, errors, something not working\naccount: login, profile, settings\nother: none of the above" },
    { id: "wants_refund", type: "noul", instructions: "Is the customer asking for a refund?", criteria: "" },
    { id: "urgency", type: "score", instructions: "How urgent is this message?",
      criteria: "No time pressure, a general question\nWants a reply soon but nothing is blocked\nNeeds action today or money/access is at stake" },
  ],
};

const $ = (s) => document.querySelector(s);
const qBox = $("#questions");
let rawEdited = false; // once the user edits the raw JSON by hand, the form stops overwriting it

const KEY_STORAGE = "jev-playground-key";

// The key lives only in this tab's memory-backed storage. sessionStorage is
// used by default (cleared when the tab closes); localStorage is opt-in via
// #remember so the key survives across sessions on this device. The key is
// never written into the saved request state, the raw JSON preview, the
// URL, or any console output.
function loadKey() {
  try {
    const fromSession = sessionStorage.getItem(KEY_STORAGE);
    if (fromSession) return { value: fromSession, remember: false };
  } catch {}
  try {
    const fromLocal = localStorage.getItem(KEY_STORAGE);
    if (fromLocal) return { value: fromLocal, remember: true };
  } catch {}
  return { value: "", remember: false };
}

function saveKey(value, remember) {
  try {
    if (value) sessionStorage.setItem(KEY_STORAGE, value);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {}
  try {
    if (remember && value) localStorage.setItem(KEY_STORAGE, value);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {}
}

function initKeyUI() {
  const input = $("#apikey");
  const remember = $("#remember");
  const forget = $("#forget");
  const initial = loadKey();
  input.value = initial.value;
  remember.checked = initial.remember;

  input.addEventListener("input", () => saveKey(input.value, remember.checked));
  remember.addEventListener("change", () => saveKey(input.value, remember.checked));
  forget.addEventListener("click", () => {
    input.value = "";
    remember.checked = false;
    saveKey("", false);
  });
}
initKeyUI();

function addQuestion(q = { id: "", type: "choice", instructions: "", criteria: "" }) {
  const el = $("#q-tpl").content.firstElementChild.cloneNode(true);
  el.querySelector(".qid").value = q.id;
  el.querySelector(".qtype").value = q.type;
  el.querySelector(".qinstr").value = q.instructions;
  el.querySelector(".qcrit").value = q.criteria;
  el.querySelector(".remove").onclick = () => { el.remove(); sync(); };
  el.addEventListener("input", sync);
  el.addEventListener("change", sync);
  qBox.append(el);
  refreshHelp(el);
}

function refreshHelp(el) {
  const [label, hint] = CRITERIA_HELP[el.querySelector(".qtype").value];
  el.querySelector(".qcrit-label").textContent = label;
  el.querySelector(".qcrit-hint").textContent = hint;
}

// "name: description" lines -> object. A line without a colon becomes name: name.
function linesToObject(text) {
  const out = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(":");
    const k = (i === -1 ? line : line.slice(0, i)).trim();
    out[k] = i === -1 ? k : line.slice(i + 1).trim();
  }
  return out;
}

function parseState(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { /* treat as text */ } }
  return text;
}

function buildRequest() {
  const questions = {};
  [...qBox.children].forEach((el, n) => {
    const id = el.querySelector(".qid").value.trim() || `q${n + 1}`;
    const type = el.querySelector(".qtype").value;
    const crit = el.querySelector(".qcrit").value;
    const q = { type, instructions: el.querySelector(".qinstr").value.trim() };
    if (type === "score") q.criteria = crit.split("\n").map((l) => l.trim()).filter(Boolean);
    else if (type === "choice" || crit.trim()) q.criteria = linesToObject(crit);
    questions[id] = q;
  });
  return { state: parseState($("#state").value), model: "jev-latest", questions };
}

function sync() {
  [...qBox.children].forEach(refreshHelp);
  if (!rawEdited) $("#raw").value = JSON.stringify(buildRequest(), null, 2);
  save();
}

// Validate before sending so mistakes show up here, not as a vague API 422.
function validate(req) {
  const errs = [];
  if (req.state === "" || req.state == null) errs.push("State is empty.");
  const qs = Object.entries(req.questions ?? {});
  if (!qs.length) errs.push("Add at least one question.");
  for (const [id, q] of qs) {
    if (!q.instructions || (typeof q.instructions === "string" && !q.instructions.trim())) errs.push(`"${id}": instructions are empty.`);
    if (q.type === "choice" && Object.keys(q.criteria ?? {}).length < 2) errs.push(`"${id}": a choice needs at least 2 options.`);
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) errs.push(`"${id}": a score needs at least 2 levels.`);
  }
  return errs;
}

async function run() {
  const key = $("#apikey").value.trim();
  if (!key) return showError("Paste your Jev API key above. Get one at console.typesafe.ai");

  let req;
  try { req = JSON.parse($("#raw").value); }
  catch (e) { return showError(`Request JSON is invalid: ${e.message}`); }
  const errs = validate(req);
  if (errs.length) return showError(errs.join("\n"));

  const btn = $("#run");
  btn.disabled = true; $("#status").textContent = "Running…";
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(req),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      if (res.status === 401) return showError("TypeSafe rejected this API key. Check it and try again.");
      if (res.status === 403) return showError("This page can't reach the relay from here (blocked origin).");
      if (res.status === 413) return showError("Request is too large.");
      if (res.status === 429) return showError("Too many runs, wait a minute.");
      return showError(`HTTP ${res.status}\n${JSON.stringify(data, null, 2)}`);
    }
    $("#status").textContent = `${res.headers.get("X-Elapsed-Ms")} ms` + (data.usage ? ` · ${data.usage.input_tokens} input tokens` : "");
    render(req, data);
  } catch (e) {
    showError(`Could not reach the relay. Try again in a moment.\n${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function showError(msg) {
  $("#status").textContent = "";
  $("#results").innerHTML = "";
  const div = document.createElement("div");
  div.className = "error"; div.textContent = msg;
  $("#results").append(div);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function bars(entries, highlight) {
  const wrap = document.createElement("div");
  for (const [name, p] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `<span class="name"></span><div class="bar"><div></div></div><span class="num"></span>`;
    row.querySelector(".name").textContent = name;
    if (name === highlight) row.querySelector(".name").style.fontWeight = "600";
    row.querySelector(".bar > div").style.width = pct(Math.max(0, Math.min(1, p)));
    row.querySelector(".num").textContent = pct(p);
    wrap.append(row);
  }
  return wrap;
}

function render(req, data) {
  const out = $("#results");
  out.innerHTML = "";
  for (const [id, a] of Object.entries(data.answers ?? {})) {
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h3");
    h.innerHTML = `<span></span><span class="tag"></span>`;
    h.children[0].textContent = id;
    h.children[1].textContent = a.type + (a.confidence != null ? ` · confidence ${pct(a.confidence)}` : "");
    card.append(h);

    const big = document.createElement("div");
    big.className = "big";
    if (a.type === "noul") {
      big.textContent = `${pct(a.noul)} yes`;
      card.append(big, bars([["yes", a.noul], ["no", 1 - a.noul]]));
    } else if (a.type === "choice") {
      big.textContent = a.choice;
      const entries = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
      card.append(big, bars(entries, a.choice));
    } else if (a.type === "score") {
      // score is a probability-weighted position on the levels (0 = first level).
      const levels = req.questions?.[id]?.criteria ?? [];
      const nearest = levels[Math.round(a.score)];
      big.textContent = `${Number(a.score).toFixed(2)}` + (levels.length ? ` / ${levels.length - 1}` : "");
      card.append(big);
      if (nearest) { const m = document.createElement("div"); m.className = "meta"; m.textContent = `Closest level: ${nearest}`; card.append(m); }
      const names = (k) => a.legend?.[k] ?? levels[Number(k)] ?? k;
      card.append(bars(Object.entries(a.probabilities ?? {}).map(([k, p]) => [names(k), p])));
    }
    out.append(card);
  }
  const d = document.createElement("details");
  d.innerHTML = "<summary class='meta'>Raw response</summary><pre></pre>";
  d.querySelector("pre").textContent = JSON.stringify(data, null, 2);
  out.append(d);
}

// Remember the last request in this browser (convenience only).
function save() {
  try { localStorage.setItem("jev-playground", JSON.stringify({ state: $("#state").value, questions: [...qBox.children].map((el) => ({
    id: el.querySelector(".qid").value, type: el.querySelector(".qtype").value,
    instructions: el.querySelector(".qinstr").value, criteria: el.querySelector(".qcrit").value })) })); } catch {}
}
function load(saved) {
  qBox.innerHTML = "";
  $("#state").value = saved.state;
  saved.questions.forEach(addQuestion);
  rawEdited = false; sync();
}

$("#state").addEventListener("input", sync);
$("#raw").addEventListener("input", () => { rawEdited = true; });
$("#add").onclick = () => { addQuestion(); rawEdited = false; sync(); };
$("#example").onclick = () => load(EXAMPLE);
$("#run").onclick = run;
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); });
qBox.addEventListener("input", () => { rawEdited = false; });

let saved = null;
try { saved = JSON.parse(localStorage.getItem("jev-playground")); } catch {}
load(saved?.questions?.length ? saved : EXAMPLE);
