"use strict";
/* Shared by every page: small helpers, loading a league's values and the
   "last updated" pill. Load after model.js and before the page's own script. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-GB"));
const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
const signedPct = (x) => `${x < 0 ? "−" : "+"}${pct(x)}`;

function horizonName(hz) {
  if (hz <= 10) return "Win Now";
  if (hz < 40) return "Leaning Win Now";
  if (hz <= 60) return "Balanced";
  if (hz < 90) return "Leaning Long-Term";
  return "Long-Term";
}

/* The league's values plus the effective config: model.config.json with the
   league's own QB premium folded in. */
async function loadLeague() {
  const slug = new URLSearchParams(location.search).get("league");
  const index = await fetch("data/index.json", { cache: "no-cache" }).then((r) => r.json());
  const lg = index.leagues.find((l) => l.slug === slug) || index.leagues[0];
  const data = await fetch(`data/values-${lg.slug}.json`, { cache: "no-cache" }).then((r) => r.json());
  data.config = { ...data.config, qb_premium: data.meta.qb_premium };
  showStatus(data.meta);
  return data;
}

function showStatus(m) {
  const lead = $("#leaguename");
  if (lead) lead.textContent = `${m.league} · ${m.season} week ${m.week}`;
  const built = new Date(m.built);
  const hours = (Date.now() - built) / 36e5;
  const when = built.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const pill = $("#status");
  const problems = (m.fetch_failures || []).length;
  pill.lastElementChild.textContent = problems ? `Updated ${when} · ${problems} source issue${problems > 1 ? "s" : ""}` : `Updated ${when}`;
  if (problems || hours > 8) pill.classList.add("warn");
  $("#built").textContent = `Last built ${built.toLocaleString("en-GB")}.`;
}

function loadFailed(err) {
  $("#status").classList.add("warn");
  $("#status").lastElementChild.textContent = "Couldn't load values";
  console.error(err);
}
