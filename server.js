import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import papierkram from './papierkram.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(papierkram);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const BUILD = '2026-07-09-2';

// Health-/Versions-Check: einfach https://huebner-dynamics-api.onrender.com/ im Browser oeffnen.
// Zeigt, welches Modell und welcher Build gerade LIVE laufen.
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'huebner-dynamics-api', model: MODEL, build: BUILD });
});

app.post('/api/scan-fahrzeugschein', async (req, res) => {
  try {
    const { b64 } = req.body;
    if (!b64) throw new Error('Kein Bild vorhanden');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: `Du bist Experte für deutsche Zulassungsbescheinigungen Teil I (Fahrzeugscheine). Lies das Bild SEHR GENAU, Zeichen für Zeichen.

SO IST DAS FORMULAR AUFGEBAUT:
- Die Nummer OBEN LINKS (z.B. "HP-K-1-035/25-00024") ist NICHT das Kennzeichen.
- KENNZEICHEN (Feld A, "Amtliches Kennzeichen"): steht LINKS in einem eigenen Kasten, größer gedruckt. Format: 1-3 Buchstaben + Leerzeichen + 1-2 Buchstaben + 1-4 Ziffern, z.B. "KH M789".
- HSN (Feld 2.1) und TSN (Feld 2.2) stehen in der ALLEROBERSTEN Zeile des Datenblocks, direkt RECHTS neben dem Erstzulassungs-Datum (Feld B).
  - HSN (2.1): GENAU 4 Ziffern, z.B. "0005".
  - TSN (2.2): alphanumerischer Code direkt rechts daneben, z.B. "BVZ00047X".
- ACHTUNG, häufiger Fehler: In der MITTE des Formulars (unter dem Hersteller) stehen weitere kurze Codes und Zahlenblöcke (Genehmigungs-/Achsdaten o.ä.). Diese sind NICHT HSN, NICHT TSN und NICHT das Modell. HSN und TSN kommen AUSSCHLIESSLICH aus der obersten Zeile neben Feld B.
- FIN (Feld E): genau 17 Zeichen.
- HERSTELLER (Feld D.1): z.B. "BMW".
- MODELL (Feld D.3, Handelsbezeichnung): die längere Typbezeichnung wie "430d" oder "318ti" - KEIN kurzer 2-Zeichen-Code.
- HALTER: Feld C.1.1 (Name) + C.1.2 (Vorname) zusammen, z.B. "Gräfin zu Münster Astrid".
- ANSCHRIFT des Halters (Feld C.1.3, steht DIREKT UNTER dem Halternamen): Straße mit Hausnummer (z.B. "Rheinstraße 35 A"), darunter PLZ (genau 5 Ziffern) und Ort (z.B. "64319 Pfungstadt"). Trenne das in drei Werte: strasse, plz, ort.
- ERSTZULASSUNG (Feld B): Datum TT.MM.JJJJ.

VORGEHEN (wichtig, in dieser Reihenfolge):
1. Transkribiere zuerst wörtlich die oberste Zeile: das Datum aus Feld B, dann den Wert bei 2.1, dann den Wert bei 2.2.
2. Lies das Kennzeichen aus dem großen Kasten links (Feld A).
3. Gib danach GENAU EIN JSON-Objekt aus.

REGELN:
- Lies NUR, was wirklich dasteht - errate nichts.
- ROTATION: Gib zusätzlich an, um wie viel Grad das Bild IM UHRZEIGERSINN gedreht werden muss, damit der Text normal lesbar (richtig herum) ist: 0, 90, 180 oder 270. Steht der Text auf dem Kopf, ist es 180.
- Wenn ein Feld nicht sicher lesbar ist: leerer String "".
- HSN immer genau 4 Ziffern.

Format (eine kurze Transkription davor ist erlaubt, danach GENAU EIN JSON-Objekt):
{"kennzeichen":"","fin":"","hsn":"","tsn":"","hersteller":"","modell":"","halter":"","erstzulassung":"","strasse":"","plz":"","ort":"","rotation":0}` },
        ],
      }],
    });

    const raw = response.content?.[0]?.text || '';
    let p = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      p = m ? JSON.parse(m[0]) : {};
    } catch (e) {
      p = {};
    }

    const fin = (p.fin || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
    const hsn = (p.hsn || '').replace(/[^0-9]/g, '').slice(0, 4);

    res.json({
      success: true,
      model: MODEL,
      build: BUILD,
      kennzeichen: (p.kennzeichen || '').trim(),
      fin: fin.length === 17 ? fin : '',
      hsn,
      tsn: (p.tsn || '').trim().slice(0, 12),
      hersteller: (p.hersteller || '').trim(),
      modell: (p.modell || '').trim(),
      halter: (p.halter || '').trim(),
      erstzulassung: (p.erstzulassung || '').trim(),
      strasse: (p.strasse || '').trim(),
      plz: (p.plz || '').replace(/[^0-9]/g, '').slice(0, 5),
      ort: (p.ort || '').trim(),
      rotation: [0, 90, 180, 270].includes(Number(p.rotation)) ? Number(p.rotation) : 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/beleg-auslesen', async (req, res) => {
  try {
    const { pdfB64 } = req.body;
    if (!pdfB64) throw new Error('Kein PDF vorhanden');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
          { type: 'text', text: `Du liest deutsche Lieferanten-Rechnungen einer Kfz-Werkstatt aus (z.B. Baltz Autoteile, Emil Frey/BMW, Wolz).

WICHTIGSTE REGEL — PREISE:
Nimm bei jeder Position IMMER den EINZEL-/LISTENPREIS NETTO VOR RABATT (den höheren Preis), NIE den rabattierten Betrag:
- Layout mit Spalten "Einzel-Preis | Rab% | Gesamt-Netto Pr." (z.B. Baltz): nimm "Einzel-Preis".
- Layout mit Spalten "Preis | Betrag" plus Rabatt-Prozent hinter dem Betrag (z.B. Emil Frey/BMW): nimm "Preis" (Stückpreis).
- Gibt es keine Rabattspalte, ist der Einzelpreis netto zu nehmen.

WEITERE FELDER:
- lieferant: Firmenname des Rechnungsstellers (z.B. "BALTZ Autoteile-Zubehör", "Emil Frey Vogel Automobile").
- rechnungsnummer: die Rechnungs-Nr. (Re.Nr / Rechnungs-Nr.).
- datum: Rechnungsdatum TT.MM.JJJJ.
- positionen: JEDE Position mit artikelnummer (falls vorhanden), bezeichnung, menge (Zahl), einzelpreisNetto (Zahl, Punkt als Dezimaltrenner). Auch Pauschalen (z.B. Servicepauschale) und Versandkosten als Position aufnehmen; wenn nur ein Gesamtbetrag dasteht, menge 1 und diesen Betrag als einzelpreisNetto.
- nettoGesamt, ustBetrag, brutto: die Summen unten auf der Rechnung (Zahlen).

REGELN: Lies NUR, was dasteht. Unsichere Felder: leer bzw. 0. Antworte mit GENAU EINEM JSON-Objekt:
{"lieferant":"","rechnungsnummer":"","datum":"","positionen":[{"artikelnummer":"","bezeichnung":"","menge":1,"einzelpreisNetto":0}],"nettoGesamt":0,"ustBetrag":0,"brutto":0}` },
        ],
      }],
    });

    const raw = response.content?.[0]?.text || '';
    let p = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      p = m ? JSON.parse(m[0]) : {};
    } catch (e) { p = {}; }

    const num = v => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
    res.json({
      success: true,
      build: BUILD,
      lieferant: (p.lieferant || '').trim(),
      rechnungsnummer: String(p.rechnungsnummer || '').trim(),
      datum: (p.datum || '').trim(),
      positionen: (Array.isArray(p.positionen) ? p.positionen : []).map(x => ({
        artikelnummer: String((x && x.artikelnummer) || '').trim(),
        bezeichnung: String((x && x.bezeichnung) || '').trim(),
        menge: num(x && x.menge) || 1,
        einzelpreisNetto: num(x && x.einzelpreisNetto),
      })).filter(x => x.bezeichnung),
      nettoGesamt: num(p.nettoGesamt),
      ustBetrag: num(p.ustBetrag),
      brutto: num(p.brutto),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend (${MODEL}, build ${BUILD}) läuft auf Port ${PORT}`));
