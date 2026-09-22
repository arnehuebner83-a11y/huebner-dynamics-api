// ============================================================================
// papierkram.js  —  Papierkram-Anbindung für huebner-dynamics-api (Render)
// Version 14 — Arbeitsstunden-Position mit Beschreibung aus den Stunden-Texten
//               (b.stundenTexte als Aufzaehlung). Vorher: Version 13 — PDF-Download: Feld 'uri' am Dokumenteintrag (aus Live-Diagnose),
//               mit Auth-Retry. Vorher: Version 12 — Rechnungspositionen mit Menge (quantity aus teileMitPreisen.menge,
//               Preis = Stueckpreis). Vorher: Version 11 — Beleg-Liste: NEUESTE zuerst (letzte Seite via total_pages);
//               PDF-Download: URL-Felder des Dokumenteintrags zuerst pruefen,
//               volle Diagnose bei Fehlschlag. Vorher: Version 10 — Beleg bucht BEZAHLTE Netto-Betraege (nach Rabatt); Rueckweg:
//               Beleg-Liste + PDF-Download aus Papierkram. Vorher: Version 9 — PDF-Anhang-Fix: Multipart-Feld heisst "file" (aus Client-Quelltext
//              verifiziert). Vorher: Version 8 — Kategorie-Fix: "Wareneingang" (gueltige Papierkram-Kategorie,
//              "Wareneinkauf" existiert nicht). Vorher: Version 7 — Beleg-Fix: vat_rate als Zahl (0.19) laut API-Schema,
//              kein Fallback ohne line_items mehr (Pflichtfeld). Vorher: Version 6 — Beleg-Import (Ausgabe-Belege aus Lieferanten-PDFs), Kundenadresse,
//              Teilepreise auf Rechnungen. Basis: Version 4:
//   Nach Finden/Anlegen wird der Kontakttyp GEPRÜFT und, falls nötig,
//   per PUT auf "Kunde" umgestellt. Klappt auch das nicht (API-Beta),
//   kommt eine klare Anleitung statt eines kryptischen Fehlers.
//
// EINBINDEN (unverändert): import papierkram from './papierkram.js';
//                          app.use(papierkram);
//
// Render → Environment:
//     PAPIERKRAM_TOKEN              = <Token>
//     PAPIERKRAM_SUBDOMAIN          = hbnerdynamics
//     PAPIERKRAM_LABOR_ID           = 3          ← "Arbeitsstunde"
//     PAPIERKRAM_PAYMENT_TERM_ID    = 24         ← "Auf Rechnung, 14 Tage (rein netto)" – EMPFOHLEN,
//                                     sonst wird die erste genommen (bei dir: Barzahlung!)
//     PAPIERKRAM_VAT                = (optional) Default "19%"
//     PAPIERKRAM_AUTOCREATE_CONTACT = (optional) "false" = neue Kunden nicht anlegen
// ============================================================================

import express from "express";

const router = express.Router();

const TOKEN = process.env.PAPIERKRAM_TOKEN || "";
const SUB = process.env.PAPIERKRAM_SUBDOMAIN || "hbnerdynamics";
const LABOR_ID = process.env.PAPIERKRAM_LABOR_ID || "";
const PAYTERM_ID = process.env.PAPIERKRAM_PAYMENT_TERM_ID || "";
const VAT = process.env.PAPIERKRAM_VAT || "19%";
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

function unwrap(d) { return (d && d.entry) ? d.entry : (d || {}); }

// Namens-Abgleich: klein, Wörter sortiert → "Palzer Michael" == "Michael Palzer"
// Rechtsformen und Anreden, die beim Vergleich nichts zur Sache tun
const NAME_FUELL = ["gmbh", "mbh", "ug", "ag", "kg", "ohg", "gbr", "ek", "co", "haftungsbeschraenkt",
                    "herr", "frau", "hr", "fr", "firma", "fa"];

// "Rössig" -> "roessig", "Anne-Marie" -> "anne marie", "José" -> "jose"
function nameNorm(s) {
  return (s == null ? "" : String(s))
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:()\/\-_&+]/g, " ");
}

// Wortmenge ohne Fuellwoerter, sortiert – Reihenfolge egal
function nameWorte(s) {
  return nameNorm(s).split(/\s+/).filter(Boolean).filter(w => NAME_FUELL.indexOf(w) < 0);
}

// Papierkram-Fehlerobjekt zu einem lesbaren Satz eindampfen
function kurzFehler(d) {
  if (!d) return "keine Angabe";
  if (typeof d === "string") return d.slice(0, 300);
  const teile = [];
  const sammle = (obj, pfad) => {
    if (obj == null) return;
    if (Array.isArray(obj)) { obj.forEach(x => sammle(x, pfad)); return; }
    if (typeof obj === "object") {
      Object.keys(obj).forEach(k => sammle(obj[k], pfad ? pfad + "." + k : k));
      return;
    }
    teile.push((pfad ? pfad + ": " : "") + String(obj));
  };
  sammle(d.errors || d.error || d, "");
  return teile.length ? teile.slice(0, 6).join(" | ").slice(0, 400) : JSON.stringify(d).slice(0, 300);
}

function nameKey(s) {
  return nameWorte(s).slice().sort().join(" ");
}

// Ist die kuerzere Wortmenge vollstaendig in der laengeren enthalten?
// Beispiel: "Rössig Kai" steckt in "Philipp Kai Rössig" -> wahrscheinlich derselbe Kunde.
// Mindestens 2 gemeinsame Woerter, sonst wuerde jeder "Müller" auf jeden anderen passen.
function nameTeilmenge(a, b) {
  const wa = nameWorte(a), wb = nameWorte(b);
  if (!wa.length || !wb.length) return false;
  const kurz = wa.length <= wb.length ? wa : wb;
  const lang = wa.length <= wb.length ? wb : wa;
  if (kurz.length < 2) return false;
  if (kurz.length === lang.length) return false;
  return kurz.every(w => lang.indexOf(w) >= 0);
}

// ISO (JJJJ-MM-TT) → TT.MM.JJJJ (für den Beschreibungstext)
function deDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? m[3] + "." + m[2] + "." + m[1] : (iso || "");
}

// ── Caches (sparen API-Credits über die Server-Laufzeit) ────────────────────
let laborCache = null;     // { id, name, price, unit }
let paytermCache = null;   // { id, name }

async function getLabor() {
  if (laborCache) return laborCache;
  const r = await pk("GET", "/income/propositions");
  if (!r.ok) return { error: { step: "propositions", status: r.status, papierkram: r.data } };
  const list = asList(r.data);
  let hit = null;
  if (LABOR_ID) hit = list.find(p => String(p.id) === String(LABOR_ID));
  if (!hit) hit = list.find(p => /stund|arbeit|lohn/i.test(String(p.name || "")));
  if (!hit && list.length === 1) hit = list[0];
  if (!hit) return { error: { step: "propositions", msg: "Arbeits-Dienstleistung nicht gefunden – PAPIERKRAM_LABOR_ID prüfen", choices: list.map(p => ({ id: p.id, name: p.name })) } };
  laborCache = { id: hit.id, name: hit.name || "Arbeitsstunde", price: Number(hit.price) || 0, unit: hit.unit_name_1 || "Stunde" };
  return laborCache;
}

async function getPaymentTerm() {
  if (paytermCache) return paytermCache;
  const r = await pk("GET", "/income/payment_terms");
  if (!r.ok) return { error: { step: "payment_terms", status: r.status, papierkram: r.data } };
  const list = asList(r.data);
  if (!list.length) return { error: { step: "payment_terms", msg: "Keine Zahlungsbedingung in Papierkram angelegt – bitte eine anlegen (Einstellungen)" } };
  let hit = null;
  if (PAYTERM_ID) hit = list.find(p => String(p.id) === String(PAYTERM_ID));
  if (!hit) hit = list[0];
  paytermCache = { id: hit.id, name: hit.name || ("ID " + hit.id) };
  return paytermCache;
}

// ============================================================================
// 1) INSPECT — rein lesend, zeigt echte Strukturen deines Kontos.
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
    probe("payment_terms (Zahlungsbedingungen)", "GET", "/income/payment_terms"),
    probe("companies (Kunden)", "GET", "/contact/companies?page_size=2"),
    probe("rechnung DETAIL", "GET", "/income/invoices/3"),
  ]);
  res.json({ base: BASE, subdomain: SUB, autocreateContact: AUTOCREATE, laborIdEnv: LABOR_ID || null, paytermIdEnv: PAYTERM_ID || null, vat: VAT, results });
});

// ── Kontakttyp sicherstellen: muss "customer" sein ──────────────────────────
async function ensureCustomer(company) {
  if ((company.contact_type || "") === "customer") return company;
  // Reparaturversuch per PUT (Name mitschicken, falls Pflichtfeld)
  const u = await pk("PUT", "/contact/companies/" + company.id, { name: company.name, contact_type: "customer" });
  let fresh = u.ok ? unwrap(u.data) : null;
  if (!fresh || (fresh.contact_type || "") !== "customer") {
    const g = await pk("GET", "/contact/companies/" + company.id);
    if (g.ok) fresh = unwrap(g.data);
  }
  if (fresh && (fresh.contact_type || "") === "customer") return { id: company.id, name: fresh.name || company.name, contact_type: "customer" };
  return { needsManual: true };
}

// ── Bestandskunde suchen (Unternehmen-Kontakte, Wortreihenfolge egal) ───────
// Liefert { exact } bei sicherem Treffer, sonst { unsicher: [...] }, sonst null
async function findContact(name) {
  const target = nameKey(name);
  if (!target) return null;
  const unsicher = [];
  for (let page = 1; page <= 20; page++) {
    const r = await pk("GET", "/contact/companies?page=" + page + "&page_size=100");
    if (!r.ok) return { httpError: { step: "contact_search", status: r.status, papierkram: r.data } };
    const list = asList(r.data);
    if (!list.length) break;
    const hit = list.find(c => nameKey(c.name) === target);
    if (hit) return { exact: hit };
    list.forEach(c => {
      if (nameTeilmenge(name, c.name) && !unsicher.some(x => x.id === c.id))
        unsicher.push({ id: c.id, name: c.name, contact_type: c.contact_type });
    });
    if (list.length < 100) break;
  }
  return unsicher.length ? { unsicher: unsicher.slice(0, 6) } : null;
}

// contactId: vom Frontend bestaetigte Auswahl – dann wird nicht mehr gesucht.
// neuAnlegen: true = Rueckfrage mit "Neu anlegen" beantwortet.
async function findOrCreateContact(name, adr, wahl) {
  const clean = (name || "").trim();
  if (!clean) return { error: { step: "contact", msg: "Kein Halter-Name übergeben (Fahrzeugschein hatte keinen)" } };
  const w = wahl || {};

  // Der Nutzer hat einen vorhandenen Kunden bestaetigt
  if (w.contactId) {
    const g = await pk("GET", "/contact/companies/" + w.contactId);
    if (!g.ok) return { error: { step: "contact", status: g.status, msg: "Ausgewählter Kunde nicht mehr gefunden (ID " + w.contactId + ")", papierkram: g.data } };
    const d = unwrap(g.data);
    const ens = await ensureCustomer({ id: d.id, name: d.name, contact_type: d.contact_type });
    if (ens.needsManual) return { error: { step: "contact_type", msg: "Kontakt \"" + d.name + "\" (ID " + d.id + ") ist nicht als KUNDE typisiert und ließ sich per API nicht umstellen." } };
    return { id: ens.id || d.id, name: ens.name || d.name, created: false };
  }

  const found = await findContact(clean);
  if (found && found.httpError) return { error: found.httpError };

  // Aehnliche Namen gefunden, aber nicht eindeutig -> nicht raten, sondern fragen
  if (found && found.unsicher && !w.neuAnlegen) {
    return { needsChoice: { gesucht: clean, kandidaten: found.unsicher } };
  }

  let company = null, created = false;
  const treffer = (found && found.exact) || null;
  if (treffer) {
    company = { id: treffer.id, name: treffer.name, contact_type: treffer.contact_type };
  } else {
    if (!AUTOCREATE) return { error: { step: "contact", msg: "Kunde \"" + clean + "\" nicht gefunden – bitte in Papierkram anlegen (Auto-Anlegen ist aus)" } };
    const createBody = { name: clean, contact_type: "customer" };
    const hasAdr = adr && (adr.street || adr.zip || adr.city);
    if (hasAdr) {
      if (adr.street) createBody.postal_street = adr.street;
      if (adr.zip) createBody.postal_zip = adr.zip;
      if (adr.city) createBody.postal_city = adr.city;
    }
    let c = await pk("POST", "/contact/companies", createBody);
    if (!c.ok && hasAdr) {
      // Rechnung darf nie an der Adresse scheitern: ohne Adresse erneut versuchen
      c = await pk("POST", "/contact/companies", { name: clean, contact_type: "customer" });
    }
    if (!c.ok) return { error: { step: "contact_create", status: c.status, sent: { name: clean }, papierkram: c.data } };
    const d = unwrap(c.data);
    if (!d.id) return { error: { step: "contact_create", msg: "Kontakt angelegt, aber keine ID in der Antwort", papierkram: c.data } };
    company = { id: d.id, name: d.name || clean, contact_type: d.contact_type };
    created = true;
  }

  // Kundenstatus prüfen und ggf. reparieren (Fix für "muss ein Kunde sein")
  const ensured = await ensureCustomer(company);
  if (ensured.needsManual) {
    return { error: { step: "contact_type", msg: "Kontakt \"" + company.name + "\" (ID " + company.id + ") ist in Papierkram nicht als KUNDE typisiert und ließ sich per API nicht umstellen. Bitte in Papierkram den Kontakt öffnen, Kontaktart auf \"Kunde\" stellen, dann erneut versuchen." } };
  }
  return { id: ensured.id || company.id, name: ensured.name || company.name, created };
}

// ============================================================================
// 2) RECHNUNGSENTWURF ANLEGEN
//    Frontend schickt: { kennzeichen, halter, leistungVon, leistungBis,
//                        rechnungsdatum, stunden, teile: [...] }
// ============================================================================
router.post("/api/papierkram-rechnung", (req, res) => rechnungHandler(req, res, null));
router.put("/api/papierkram-rechnung/:id", (req, res) => rechnungHandler(req, res, req.params.id));

async function rechnungHandler(req, res, updateId) {
  try {
    if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt (Render Environment)" });
    const b = req.body || {};

    const labor = await getLabor();
    if (labor.error) return res.status(502).json({ ok: false, ...labor.error });

    const payterm = await getPaymentTerm();
    if (payterm.error) return res.status(502).json({ ok: false, ...payterm.error });

    const contact = await findOrCreateContact(b.halter,
      { street: String(b.strasse || "").trim(), zip: String(b.plz || "").trim(), city: String(b.ort || "").trim() },
      { contactId: b.contactId, neuAnlegen: !!b.neuerKunde });
    if (contact.needsChoice) return res.status(409).json({ ok: false, needsChoice: contact.needsChoice });
    if (contact.error) return res.status(502).json({ ok: false, ...contact.error });

    // Positionen: Arbeitsstunden (echter Preis aus Papierkram) + Teile (Preis 0, füllst du aus)
    const lineItems = [];
    const stunden = Number(b.stunden) || 0;
    if (stunden > 0) {
      const li = { name: labor.name, quantity: stunden, unit: labor.unit, price: labor.price, vat_rate: VAT };
      const texte = (Array.isArray(b.stundenTexte) ? b.stundenTexte : []).map(t => String(t || "").trim()).filter(Boolean);
      if (texte.length) li.description = texte.map(t => "\u2022 " + t).join("\n");
      lineItems.push(li);
    }
    const mitPreisen = Array.isArray(b.teileMitPreisen) && b.teileMitPreisen.length ? b.teileMitPreisen : null;
    if (mitPreisen) {
      mitPreisen.forEach(t => { const s = String((t && t.name) || "").trim(); if (s) lineItems.push({ name: s, quantity: Number(t && t.menge) || 1, unit: "Stück", price: Number(t && t.preis) || 0, vat_rate: VAT }); });
    } else {
      (b.teile || []).forEach(t => { const s = String(t || "").trim(); if (s) lineItems.push({ name: s, quantity: 1, unit: "Stück", price: 0, vat_rate: VAT }); });
    }
    if (!lineItems.length) return res.status(400).json({ ok: false, msg: "Keine Positionen (weder Stunden noch Teile) – Rechnung wäre leer." });

    const von = deDate(b.leistungVon), bis = deDate(b.leistungBis);
    const zeitraum = (von && bis && von !== bis) ? (von + " \u2013 " + bis) : (bis || von);
    const body = {
      name: b.kennzeichen || "Werkstattauftrag",
      document_date: b.rechnungsdatum,
      supply_date: b.leistungBis || b.rechnungsdatum,
      description: zeitraum ? ("Leistungszeitraum: " + zeitraum) : "",
      payment_term: { id: payterm.id },
      customer: { id: contact.id },
      line_items: lineItems,
    };

    let inv;
    if (updateId) {
      inv = await pk("PATCH", "/income/invoices/" + updateId, body);
      if (!inv.ok && (inv.status === 404 || inv.status === 405)) {
        inv = await pk("PUT", "/income/invoices/" + updateId, body);
      }
      if (!inv.ok) {
        const hint = inv.status === 404
          ? "Rechnung " + updateId + " nicht gefunden \u2013 evtl. in Papierkram gel\u00f6scht. Bitte neu anlegen."
          : (inv.status === 422 || inv.status === 403)
            ? "Papierkram l\u00e4sst diese Rechnung nicht mehr \u00e4ndern \u2013 vermutlich ist sie bereits festgeschrieben oder versendet. In Papierkram wieder in den Entwurf zur\u00fccksetzen oder eine neue Rechnung anlegen."
            : "\u00c4nderung abgelehnt (HTTP " + inv.status + ").";
        return res.status(502).json({ ok: false, step: "invoice_update", status: inv.status, msg: hint, sent: body, papierkram: inv.data });
      }
    } else {
      inv = await pk("POST", "/income/invoices", body);
      if (!inv.ok) {
        return res.status(502).json({ ok: false, step: "invoice_create", status: inv.status, sent: body, papierkram: inv.data });
      }
    }
    const d = unwrap(inv.data);
    return res.json({
      ok: true,
      updated: !!updateId,
      invoiceId: d.id || updateId || null,
      contactCreated: !!contact.created,
      contactName: contact.name,
      laborUsed: labor.name + " (" + labor.price + " \u20AC/" + labor.unit + ")",
      paymentTerm: payterm.name,
      url: `https://${SUB}.papierkram.de/`,
      papierkram: d,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Serverfehler", detail: String(e) });
  }
}

// ============================================================================
// 2b) ANGEBOT / KOSTENVORANSCHLAG ANLEGEN
//     Frontend schickt: { kennzeichen, halter, strasse, plz, ort, datum,
//                         positionen: [{ text, menge, preis, einheit }],  <- preis BRUTTO
//                         hinweis, contactId?, neuerKunde? }
// ============================================================================
router.post("/api/papierkram-angebot", async (req, res) => {
  try {
    if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt (Render Environment)" });
    const b = req.body || {};

    const contact = await findOrCreateContact(b.halter,
      { street: String(b.strasse || "").trim(), zip: String(b.plz || "").trim(), city: String(b.ort || "").trim() },
      { contactId: b.contactId, neuAnlegen: !!b.neuerKunde });
    if (contact.needsChoice) return res.status(409).json({ ok: false, needsChoice: contact.needsChoice });
    if (contact.error) return res.status(502).json({ ok: false, ...contact.error });

    // Die App rechnet in BRUTTO, Papierkram will den Nettopreis je Einheit
    const lineItems = [];
    (Array.isArray(b.positionen) ? b.positionen : []).forEach(p => {
      const text = String((p && p.text) || "").trim();
      if (!text) return;
      const menge = Number(p && p.menge) || 0;
      const brutto = Number(p && p.preis) || 0;
      const netto = Math.round((brutto / (1 + VAT)) * 100) / 100;
      lineItems.push({
        name: text,
        quantity: menge,
        unit: (p && p.einheit === "h") ? "Stunde" : "Stück",
        price: netto,
        vat_rate: VAT,
      });
    });
    if (!lineItems.length) return res.status(400).json({ ok: false, msg: "Keine Positionen – das Angebot wäre leer." });

    const heute = new Date();
    const iso = d => d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    const gueltigBis = new Date(heute.getTime() + 30 * 86400000);
    const body = {
      name: b.kennzeichen || "Kostenvoranschlag",
      document_date: b.datum || iso(heute),
      valid_until: b.gueltigBis || iso(gueltigBis),
      customer: { id: contact.id },
      line_items: lineItems,
    };
    // Rechnungen brauchen eine Zahlungsbedingung – Angebote vermutlich auch
    const pt = await getPaymentTerm();
    if (!pt.error) body.payment_term = { id: pt.id };
    const hinweis = String(b.hinweis || "").trim();
    if (hinweis) body.description = hinweis;

    let est = await pk("POST", "/income/estimates", body);
    if (!est.ok) {
      return res.status(502).json({
        ok: false, step: "estimate_create", status: est.status,
        msg: est.status === 404
          ? "Papierkram kennt /income/estimates nicht – bitte /api/angebot-inspect aufrufen und das Ergebnis schicken."
          : "Angebot abgelehnt (HTTP " + est.status + "): " + kurzFehler(est.data),
        sent: body, papierkram: est.data,
      });
    }
    const d = unwrap(est.data);
    return res.json({
      ok: true,
      estimateId: d.id || null,
      contactCreated: !!contact.created,
      contactName: contact.name,
      url: `https://${SUB}.papierkram.de/`,
      papierkram: d,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Serverfehler", detail: String(e) });
  }
});

// ── Angebot-Selbsttest: probiert Strukturvarianten und meldet, welche geht ──
//    Erfolgreiche Testangebote werden sofort wieder geloescht.
router.get("/api/angebot-test", async (req, res) => {
  if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt" });
  try {
    // Einen vorhandenen Kunden nehmen, damit die Kundenanlage nicht stoert
    const kl = await pk("GET", "/contact/companies?page_size=100");
    if (!kl.ok) return res.status(502).json({ ok: false, step: "kundenliste", status: kl.status, papierkram: kl.data });
    const kunden = asList(kl.data).filter(c => (c.contact_type || "") === "customer");
    if (!kunden.length) return res.status(400).json({ ok: false, msg: "Kein Kontakt vom Typ \"customer\" gefunden – bitte in Papierkram einen Kunden anlegen." });
    const kunde = kunden[0];

    const heute = new Date();
    const iso = d => d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    const in30 = iso(new Date(heute.getTime() + 30 * 86400000));
    const pt = await getPaymentTerm();
    const ptId = pt && !pt.error ? pt.id : null;
    const posMin = [{ name: "Testposition", quantity: 1, unit: "Stück", price: 100, vat_rate: VAT }];

    const varianten = [
      { was: "minimal (name, document_date, customer, line_items)",
        body: { name: "SELBSTTEST", document_date: iso(heute), customer: { id: kunde.id }, line_items: posMin } },
      { was: "+ payment_term",
        body: { name: "SELBSTTEST", document_date: iso(heute), customer: { id: kunde.id }, line_items: posMin, payment_term: ptId ? { id: ptId } : undefined } },
      { was: "+ valid_until",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer: { id: kunde.id }, line_items: posMin } },
      { was: "+ payment_term + valid_until",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer: { id: kunde.id }, line_items: posMin, payment_term: ptId ? { id: ptId } : undefined } },
      { was: "customer_id statt customer-Objekt",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer_id: kunde.id, line_items: posMin } },
      { was: "contact statt customer",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, contact: { id: kunde.id }, line_items: posMin } },
      { was: "vat_rate als ganze Zahl (19)",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer: { id: kunde.id }, line_items: [{ name: "Testposition", quantity: 1, unit: "Stück", price: 100, vat_rate: 19 }] } },
      { was: "line_items ohne unit",
        body: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer: { id: kunde.id }, line_items: [{ name: "Testposition", quantity: 1, price: 100, vat_rate: VAT }] } },
      { was: "in estimate eingepackt",
        body: { estimate: { name: "SELBSTTEST", document_date: iso(heute), valid_until: in30, customer: { id: kunde.id }, line_items: posMin } } },
    ];

    const protokoll = [];
    let gewinner = null;
    for (let i = 0; i < varianten.length; i++) {
      const v = varianten[i];
      const clean = JSON.parse(JSON.stringify(v.body)); // undefined-Felder entfernen
      const r = await pk("POST", "/income/estimates", clean);
      protokoll.push({ variante: v.was, status: r.status, ok: r.ok, antwort: r.ok ? "angelegt" : r.data });
      if (r.ok) {
        const d = unwrap(r.data);
        gewinner = { variante: v.was, gesendet: clean, id: d.id || null };
        // Testangebot sofort wieder entfernen
        if (d.id) {
          const del = await pk("DELETE", "/income/estimates/" + d.id);
          gewinner.wiederGeloescht = !!del.ok;
          if (!del.ok) gewinner.loeschHinweis = "Konnte nicht geloescht werden (HTTP " + del.status + ") – bitte in Papierkram das Angebot \"SELBSTTEST\" von Hand loeschen.";
        }
        break;
      }
    }
    return res.json({
      ok: !!gewinner,
      kundeBenutzt: kunde.name,
      zahlungsbedingung: ptId,
      gewinner: gewinner,
      hinweis: gewinner ? "Diese Variante funktioniert – bitte an Claude schicken." : "Keine Variante akzeptiert. Das vollstaendige Protokoll unten an Claude schicken.",
      protokoll: protokoll,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Serverfehler", detail: String(e) });
  }
});

// ── Angebote: rein lesende Diagnose (Schema vorhandener Angebote ansehen) ───
router.get("/api/angebot-inspect", async (req, res) => {
  if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt" });
  const r = await pk("GET", "/income/estimates?page_size=3");
  res.json({ ok: r.ok, status: r.status, papierkram: r.data });
});

// ── Kundensuche: was findet der Abgleich zu einem Namen? ────────────────────
router.get("/api/kunde-pruefen", async (req, res) => {
  if (!TOKEN) return res.status(500).json({ ok: false, msg: "PAPIERKRAM_TOKEN fehlt" });
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, msg: "Parameter ?name= fehlt" });
  const f = await findContact(name);
  if (f && f.httpError) return res.status(502).json({ ok: false, ...f.httpError });
  res.json({
    ok: true, gesucht: name, schluessel: nameKey(name),
    treffer: (f && f.exact) ? { id: f.exact.id, name: f.exact.name } : null,
    unsicher: (f && f.unsicher) || [],
  });
});

// ── Beleg-Import: rein lesende Diagnose (Schema vorhandener Belege ansehen) ──
router.get("/api/voucher-inspect", async (req, res) => {
  const r = await pk("GET", "/expense/vouchers?page_size=3");
  res.json({ status: r.status, data: r.data });
});

// TT.MM.JJJJ → ISO; sonst heutiges Datum
function isoFromDe(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(s || "").trim());
  if (!m) return null;
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── Rückweg: letzte Belege auflisten ──
router.get("/api/beleg-liste", async (req, res) => {
  const first = await pk("GET", "/expense/vouchers?page_size=20");
  if (!first.ok) return res.status(502).json({ ok: false, status: first.status, papierkram: first.data });
  const u0 = first.data || {};
  const totalPages = Number(u0.total_pages) || 1;
  let entries = u0.entries || [];
  if (totalPages > 1) {
    const last = await pk("GET", "/expense/vouchers?page_size=20&page=" + totalPages);
    entries = (last.ok && last.data && last.data.entries) || [];
    if (entries.length < 20 && totalPages > 1) {
      const prev = await pk("GET", "/expense/vouchers?page_size=20&page=" + (totalPages - 1));
      const prevEntries = (prev.ok && prev.data && prev.data.entries) || [];
      entries = prevEntries.concat(entries);
    }
  }
  // Neueste zuerst, maximal 20
  entries = entries.slice(-20).reverse();
  res.json({ ok: true, belege: entries.map(v => ({ id: v.id, name: v.name, voucher_no: v.voucher_no, document_date: v.document_date, amount: v.amount })) });
});

// ── Rückweg: PDF-Anhang eines Belegs laden (defensiv, Format teils undokumentiert) ──
router.get("/api/beleg-pdf/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let list = [];
    const docs = await pk("GET", "/expense/vouchers/" + id + "/documents");
    if (docs.ok) {
      const u = docs.data || {};
      list = Array.isArray(u) ? u : (u.entries || (u.data && u.data.entries) || []);
    }
    if (!list.length) {
      const det = await pk("GET", "/expense/vouchers/" + id);
      const d = unwrap(det.data) || {};
      list = d.documents || [];
      if (!list.length) return res.status(404).json({ ok: false, step: "no_documents", voucherId: id, docsStatus: docs.status, docsRaw: docs.data });
    }
    const first = list[0] || {};
    const docId = first.id || first.document_id;

    async function toB64(r2) {
      const ab = await r2.arrayBuffer();
      return Buffer.from(ab).toString("base64");
    }
    async function fetchUrl(url) {
      const abs = url.indexOf("http") === 0 ? url : BASE.replace("/api/v1", "") + url;
      // Erst ohne Auth (signierte Anhang-URLs), bei Ablehnung mit Bearer erneut
      let r5 = await fetch(abs);
      if (!r5.ok && (r5.status === 401 || r5.status === 403)) {
        r5 = await fetch(abs, { headers: { "Authorization": "Bearer " + TOKEN } });
      }
      return { r: r5, abs };
    }

    // 1) URL-Felder direkt am Dokumenteintrag (der Einzelabruf per ID liefert 404)
    const entryUrl = first.uri || first.url || first.file_url || first.download_url || (first.file && first.file.url) || (first.document && first.document.url) || first.path;
    if (entryUrl) {
      const { r: rE, abs } = await fetchUrl(entryUrl);
      if (rE.ok) return res.json({ ok: true, pdfB64: await toB64(rE) });
      return res.status(502).json({ ok: false, step: "entry_url_download", status: rE.status, url: abs, entry: first });
    }

    // 2) Letzter Versuch: Dokument-Ressource per ID (kann 404 sein)
    if (docId) {
      const r2 = await fetch(BASE + "/expense/vouchers/" + id + "/documents/" + docId, { headers: { "Authorization": "Bearer " + TOKEN } });
      const ct = (r2.headers.get("content-type") || "").toLowerCase();
      if (r2.ok && ct.indexOf("json") < 0) return res.json({ ok: true, pdfB64: await toB64(r2) });
      if (r2.ok) {
        // JSON-Metadaten: nach einer Datei-URL suchen
        const meta = await r2.json().catch(() => ({}));
        const m = unwrap(meta) || meta || {};
        const url = m.url || m.file_url || m.download_url || (m.file && m.file.url);
        if (url) {
          const abs = url.indexOf("http") === 0 ? url : BASE.replace("/api/v1", "") + url;
          const r3 = await fetch(abs, abs.indexOf(BASE) === 0 ? { headers: { "Authorization": "Bearer " + TOKEN } } : {});
          if (r3.ok) return res.json({ ok: true, pdfB64: await toB64(r3) });
          return res.status(502).json({ ok: false, step: "file_url_download", status: r3.status, url: abs });
        }
        return res.status(502).json({ ok: false, step: "no_file_url", meta: m });
      }
      return res.status(502).json({ ok: false, step: "document_get", status: r2.status, entry: first, hinweis: "Bitte diesen Fehler kopieren und schicken \u2013 der Eintrag zeigt die echten Feldnamen." });
    }
    return res.status(404).json({ ok: false, step: "no_document_id_no_url", entry: first, hinweis: "Bitte diesen Fehler kopieren und schicken \u2013 der Eintrag zeigt die echten Feldnamen." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Beleg-Import: Ausgabe-Beleg anlegen (+ PDF anhängen, wenn möglich) ──
router.post("/api/beleg-anlegen", async (req, res) => {
  try {
    const b = req.body || {};
    const KAT = process.env.PAPIERKRAM_BELEG_KATEGORIE || "Wareneingang";
    const name = ((b.lieferant || "Beleg") + (b.rechnungsnummer ? " " + b.rechnungsnummer : "")).slice(0, 100);
    const docDate = isoFromDe(b.datum) || new Date().toISOString().split("T")[0];
    // API-Schema (verifiziert): vat_rate ist eine ZAHL (z.B. 0.19), category ein Name-String
    const VAT_NUM = (parseFloat(String(VAT).replace("%", "").replace(",", ".")) || 19) / 100;
    const items = (Array.isArray(b.positionen) ? b.positionen : [])
      .map(p => ({
        name: [String((p && p.bezeichnung) || "").trim(), (Number(p && p.menge) || 1) > 1 ? (Number(p.menge) + " Stk \u00e0 " + round2(p.einzelpreis).toFixed(2) + " \u20ac") : ""].filter(Boolean).join(" \u00b7 ").slice(0, 150),
        amount: (Number(p && p.betrag) > 0) ? round2(p.betrag) : round2((Number(p && p.menge) || 1) * (Number(p && p.einzelpreis) || 0)),
        vat_rate: VAT_NUM,
        category: KAT,
      }))
      .filter(i => i.name);
    if (!items.length) return res.status(400).json({ ok: false, error: "Mindestens eine Position wird ben\u00f6tigt (line_items ist bei Papierkram Pflicht)." });

    const body = {
      name,
      document_date: docDate,
      description: "Automatisch aus PDF \u00fcbernommen" + (b.rechnungsnummer ? " (Re.Nr " + b.rechnungsnummer + ")" : ""),
      provenance: "domestic",
      line_items: items,
    };

    const v = await pk("POST", "/expense/vouchers", body);
    const itemsUsed = true;
    if (!v.ok) return res.status(502).json({ ok: false, step: "voucher_create", status: v.status, sent: body, papierkram: v.data });

    const d = unwrap(v.data);

    // PDF anhängen (best effort – Beleg existiert auch ohne Anhang)
    let pdfAttached = false;
    if (b.pdfB64 && d.id) {
      try {
        const fd = new FormData();
        const buf = Buffer.from(b.pdfB64, "base64");
        fd.append("file", new Blob([buf], { type: "application/pdf" }), (b.pdfName || "beleg.pdf"));
        const up = await fetch(BASE + "/expense/vouchers/" + d.id + "/documents", {
          method: "POST",
          headers: { "Authorization": "Bearer " + TOKEN, "Accept": "application/json" },
          body: fd,
        });
        pdfAttached = up.ok;
      } catch (e) { pdfAttached = false; }
    }

    res.json({ ok: true, voucherId: d.id || null, voucherNo: d.voucher_no || "", name, itemsUsed, pdfAttached });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
