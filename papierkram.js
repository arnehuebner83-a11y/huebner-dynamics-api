// ============================================================================
// papierkram.js  —  Papierkram-Anbindung für huebner-dynamics-api (Render)
// Version 2 — Pfade & Felder an die echte API angepasst (aus /inspect + Doku):
//   • Kunden = "Unternehmen"-Kontakte unter /contact/companies (auch Privatkunden)
//   • Rechnung: name (=Kennzeichen), document_date, supply_date (Freitext,
//     deutsches Format = Leistungszeitraum), line_items, customer
//
// EINBINDEN (hast du schon): import papierkram from './papierkram.js';
//                            app.use(papierkram);
//
// Render → Environment:
//     PAPIERKRAM_TOKEN              = <Token>
//     PAPIERKRAM_SUBDOMAIN          = hbnerdynamics
//     PAPIERKRAM_LABOR_ID           = 3        ← "Arbeitsstunde" (98 €/h), empfohlen!
//     PAPIERKRAM_AUTOCREATE_CONTACT = (optional) "false" = neue Kunden nicht anlegen
// ============================================================================

import express from "express";

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

function asList(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.entries)) return d.entries;
  if (Array.isArray(d.data)) return d.data;
  return [];
}

// Namens-Abgleich: klein, Wörter sortiert → "Palzer Michael" == "Michael Palzer"
function nameKey(s) {
  return (s == null ? "" : String(s)).toLowerCase().replace(/[.,]/g, " ")
    .split(/\s+/).filter(Boolean).sort().join(" ");
}

// ISO (JJJJ-MM-TT) → deutsches Format TT.MM.JJJJ (für supply_date-Freitext)
function deDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? m[3] + "." + m[2] + "." + m[1] : (iso || "");
}

// ============================================================================
// 1) INSPECT — rein lesend, zeigt echte Strukturen deines Kontos.
//    Browser:  https://huebner-dynamics-api.onrender.com/api/papierkram-inspect
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
    probe("companies (Kunden)", "GET", "/contact/companies?page_size=2"),
    probe("rechnung DETAIL (zeigt line_items/customer)", "GET", "/income/invoices/3"),
    probe("propositions", "GET", "/income/propositions"),
  ]);
  res.json({ base: BASE, subdomain: SUB, autocreateContact: AUTOCREATE, laborIdEnv: LABOR_ID || null, results });
});

// ── Arbeits-Dienstleistung ──────────────────────────────────────────────────
async function findLaborProposition() {
  if (LABOR_ID) return { id: Number(LABOR_ID) || LABOR_ID, name: "aus PAPIERKRAM_LABOR_ID" };
  const r = await pk("GET", "/income/propositions");
  if (!r.ok) return { error: { step: "propositions", status: r.status, papierkram: r.data } };
  const list = asList(r.data);
  const hit = list.find(p => /stund|arbeit|lohn/i.test(String(p.name || "")))
    || (list.length === 1 ? list[0] : null);
  if (!hit) return { error: { step: "propositions", msg: "Arbeits-Dienstleistung nicht eindeutig – bitte PAPIERKRAM_LABOR_ID setzen", choices: list.map(p => ({ id: p.id, name: p.name })) } };
  return { id: hit.id, name: hit.name };
}

// ── Bestandskunde suchen (Unternehmen-Kontakte, Wortreihenfolge egal) ───────
async function findContact(name) {
  const target = nameKey(name);
  if (!target) return null;
  for (let page = 1; page <= 10; page++) {
    const r = await pk("GET", "/contact/companies?page=" + page + "&page_size=100");
    if (!r.ok) return { httpError: { step: "contact_search", status: r.status, papierkram: r.data } };
    const list = asList(r.data);
    if (!list.length) break;
    const hit = list.find(c => nameKey(c.name) === target);
    if (hit) return hit;
    if (list.length < 100) break;
  }
  return null;
}

async function findOrCreateContact(name) {
  const clean = (name || "").trim();
  if (!clean) return { error: { step: "contact", msg: "Kein Halter-Name übergeben (Fahrzeugschein hatte keinen)" } };
  const found = await findContact(clean);
  if (found && found.httpError) return { error: found.httpError };
  if (found) return { id: found.id, name: found.name, created: false };
  if (!AUTOCREATE) return { error: { step: "contact", msg: "Kunde \"" + clean + "\" nicht gefunden – bitte in Papierkram anlegen (Auto-Anlegen ist aus)" } };
  const c = await pk("POST", "/contact/companies", { name: clean, contact_type: "customer" });
  if (!c.ok) return { error: { step: "contact_create", status: c.status, sent: { name: clean }, papierkram: c.data } };
  const d = c.data || {};
  const id = d.id || (d.entry && d.entry.id) || null;
  return { id, name: clean, created: true };
}

// ── Rechnungs-Body (Feldnamen aus echter Rechnungsstruktur) ─────────────────
function buildInvoiceBody({ contactId, kennzeichen, rechnungsdatum, leistungVon, leistungBis, laborId, stunden, teile }) {
  const lineItems = [];
  if (stunden && stunden > 0) lineItems.push({ proposition_id: laborId, quantity: stunden });
  (teile || []).forEach(t => { if (t && String(t).trim()) lineItems.push({ name: String(t).trim(), quantity: 1 }); });
  const von = deDate(leistungVon), bis = deDate(leistungBis);
  return {
    customer_id: contactId,
    customer: { id: contactId },
    name: kennzeichen || "Werkstattauftrag",
    document_date: rechnungsdatum,
    supply_date: (von && bis && von !== bis) ? (von + " - " + bis) : (bis || von),
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
      // Papierkram-Antwort im Klartext zurück – damit fixen wir Feldnamen sofort
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

export default router;
