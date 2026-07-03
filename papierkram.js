// ============================================================================
// papierkram.js  —  Papierkram-Anbindung für huebner-dynamics-api (Render)
// ----------------------------------------------------------------------------
// EINBINDEN — in deiner Server-Hauptdatei (die mit  const app = express()  ),
// meist server.js oder index.js, GANZ OBEN bei den anderen require(...):
//
//     const papierkram = require("./papierkram");
//
// und WEITER UNTEN, NACH  app.use(express.json())  und nach evtl. app.use(cors()),
// aber VOR  app.listen(...) :
//
//     app.use(papierkram);          // stellt /api/papierkram-inspect und
//                                   //         /api/papierkram-rechnung bereit
//
// Render → Environment → Variablen:
//     PAPIERKRAM_TOKEN              = <dein API-Token>   (NUR hier, nie im Frontend!)
//     PAPIERKRAM_SUBDOMAIN          = hbnerdynamics
//     PAPIERKRAM_LABOR_ID           = (optional) ID deiner Arbeits-Dienstleistung
//     PAPIERKRAM_AUTOCREATE_CONTACT = (optional) "false" = neue Kunden NICHT
//                                     automatisch anlegen (Default: anlegen)
//
// Braucht Node 18+ (globales fetch). express.json() muss aktiv sein (req.body).
// ============================================================================

const express = require("express");
const router = express.Router();

const TOKEN = process.env.PAPIERKRAM_TOKEN || "";
const SUB = process.env.PAPIERKRAM_SUBDOMAIN || "hbnerdynamics";
const LABOR_ID = process.env.PAPIERKRAM_LABOR_ID || "";
const AUTOCREATE = String(process.env.PAPIERKRAM_AUTOCREATE_CONTACT || "true") !== "false";
const BASE = `https://${SUB}.papierkram.de/api/v1`;

// ── Papierkram-Fetch-Helfer ─────────────────────────────────────────────────
async function pk(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Papierkram-Listen kommen i.d.R. als { entries: [...] }. Beides abfangen.
function asList(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.entries)) return d.entries;
  if (Array.isArray(d.data)) return d.data;
  return [];
}

// Namen vereinheitlichen (für Kundenabgleich): klein, Mehrfach-Leerzeichen weg.
function norm(s) { return (s == null ? "" : String(s)).toLowerCase().replace(/\s+/g, " ").trim(); }
function contactName(c) {
  return c.name || c.company_name || c.display_name
    || ((c.first_name || "") + " " + (c.last_name || "")).trim()
    || "";
}

// ============================================================================
// 1) INSPECT — rein lesend. Zeigt, welche Endpunkte/Formate dein Konto liefert.
//    Im Browser:  https://huebner-dynamics-api.onrender.com/api/papierkram-inspect
// ============================================================================
router.get("/api/papierkram-inspect", async (req, res) => {
  if (!TOKEN) return res.status(500).json({ error: "PAPIERKRAM_TOKEN fehlt (Render Environment)" });
  const probe = async (label, method, path) => {
    try {
      const r = await pk(method, path);
      let sample = r.data;
      const list = asList(r.data);
      if (list.length) sample = { count: list.length, first: list[0] };
      return { label, path, status: r.status, ok: r.ok, sample };
    } catch (e) { return { label, path, error: String(e) }; }
  };
  const results = await Promise.all([
    probe("info", "GET", "/info"),
    probe("propositions (Dienstleistungen)", "GET", "/income/propositions"),
    probe("contacts", "GET", "/contacts"),
    probe("income_contacts", "GET", "/income/contacts"),
    probe("invoices (1 Beispiel)", "GET", "/income/invoices?page_size=1"),
  ]);
  res.json({ base: BASE, subdomain: SUB, autocreateContact: AUTOCREATE, results });
});

// ── Arbeits-Dienstleistung finden ("auslesen") ──────────────────────────────
async function findLaborProposition() {
  if (LABOR_ID) return { id: LABOR_ID, source: "env" };
  const r = await pk("GET", "/income/propositions");
  if (!r.ok) return { error: { step: "propositions", status: r.status, papierkram: r.data } };
  const list = asList(r.data);
  if (!list.length) return { error: { step: "propositions", status: r.status, msg: "Keine Dienstleistungen gefunden", papierkram: r.data } };
  const hit = list.find(p => /stund|arbeit|lohn/i.test(JSON.stringify(p.name || p.title || "")))
    || list.find(p => /stund|\bh\b|hour/i.test(JSON.stringify(p.unit || p.unit_name || "")))
    || (list.length === 1 ? list[0] : null);
  if (!hit) return { error: { step: "propositions", msg: "Arbeits-Dienstleistung nicht eindeutig – bitte PAPIERKRAM_LABOR_ID setzen", choices: list.map(p => ({ id: p.id, name: p.name || p.title })) } };
  return { id: hit.id, name: hit.name || hit.title };
}

// ── Bestandskunde suchen (mehrere Seiten + Namen normalisiert) ──────────────
async function findContact(name) {
  const target = norm(name);
  if (!target) return null;
  // a) Server-Suche versuchen (falls Papierkram ?q= kennt – sonst harmlos ignoriert)
  let r = await pk("GET", "/contacts?q=" + encodeURIComponent(name));
  let hit = (r.ok ? asList(r.data) : []).find(c => norm(contactName(c)) === target);
  if (hit) return hit;
  // b) paginiert durchsuchen
  for (let page = 1; page <= 10; page++) {
    r = await pk("GET", "/contacts?page=" + page + "&page_size=100");
    if (!r.ok) break;
    const list = asList(r.data);
    if (!list.length) break;
    hit = list.find(c => norm(contactName(c)) === target);
    if (hit) return hit;
    if (list.length < 100) break; // letzte Seite erreicht
  }
  return null;
}

async function findOrCreateContact(name) {
  const clean = (name || "").trim();
  if (!clean) return { error: { step: "contact", msg: "Kein Halter-Name übergeben (Fahrzeugschein hatte keinen)" } };
  const found = await findContact(clean);
  if (found) return { id: found.id, name: contactName(found), created: false };
  if (!AUTOCREATE) return { error: { step: "contact", msg: "Kunde \"" + clean + "\" nicht gefunden – bitte in Papierkram anlegen/zuordnen (Auto-Anlegen ist aus)" } };
  const c = await pk("POST", "/contacts", { name: clean });
  if (!c.ok) return { error: { step: "contact_create", status: c.status, sent: { name: clean }, papierkram: c.data } };
  const id = (c.data && (c.data.id || (c.data.entry && c.data.entry.id))) || null;
  return { id, name: clean, created: true };
}

// ── Rechnungs-Body bauen (eine Stelle, leicht anpassbar nach /inspect) ──────
function buildInvoiceBody({ contactId, kennzeichen, rechnungsdatum, leistungVon, leistungBis, laborId, stunden, teile }) {
  const lineItems = [];
  if (stunden && stunden > 0) lineItems.push({ proposition_id: laborId, quantity: stunden });
  (teile || []).forEach(t => { if (t && String(t).trim()) lineItems.push({ name: String(t).trim(), quantity: 1 }); });
  return {
    contact_id: contactId,
    subject: kennzeichen || "",
    date: rechnungsdatum,
    service_period_start: leistungVon,
    service_period_end: leistungBis,
    line_items: lineItems,
  };
}

// ============================================================================
// 2) RECHNUNGSENTWURF ANLEGEN
//    Frontend schickt: { kennzeichen, halter, leistungVon, leistungBis,
//                        rechnungsdatum, stunden, teile: [...] }
// ============================================================================
router.post("/api/papierkram-rechnung", async (req, res) => {
  try {
    if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt (Render Environment)" });
    const b = req.body || {};

    const labor = await findLaborProposition();
    if (labor.error) return res.status(502).json({ ok: false, ...labor.error });

    const contact = await findOrCreateContact(b.halter);
    if (contact.error) return res.status(502).json({ ok: false, ...contact.error });

    const body = buildInvoiceBody({
      contactId: contact.id,
      kennzeichen: b.kennzeichen,
      rechnungsdatum: b.rechnungsdatum,
      leistungVon: b.leistungVon,
      leistungBis: b.leistungBis,
      laborId: labor.id,
      stunden: Number(b.stunden) || 0,
      teile: b.teile || [],
    });

    const inv = await pk("POST", "/income/invoices", body);
    if (!inv.ok) {
      return res.status(502).json({ ok: false, step: "invoice_create", status: inv.status, sent: body, papierkram: inv.data });
    }
    const d = inv.data || {};
    const invoiceId = d.id || (d.entry && d.entry.id) || null;
    return res.json({
      ok: true,
      invoiceId,
      contactCreated: !!contact.created,
      contactName: contact.name,
      laborUsed: labor.name || labor.id,
      url: `https://${SUB}.papierkram.de/`,
      papierkram: d,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Serverfehler", detail: String(e) });
  }
});

module.exports = router;
