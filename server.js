import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const BUILD = '2026-05-31-1';

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
- ERSTZULASSUNG (Feld B): Datum TT.MM.JJJJ.

VORGEHEN (wichtig, in dieser Reihenfolge):
1. Transkribiere zuerst wörtlich die oberste Zeile: das Datum aus Feld B, dann den Wert bei 2.1, dann den Wert bei 2.2.
2. Lies das Kennzeichen aus dem großen Kasten links (Feld A).
3. Gib danach GENAU EIN JSON-Objekt aus.

REGELN:
- Lies NUR, was wirklich dasteht - errate nichts.
- Wenn ein Feld nicht sicher lesbar ist: leerer String "".
- HSN immer genau 4 Ziffern.

Format (eine kurze Transkription davor ist erlaubt, danach GENAU EIN JSON-Objekt):
{"kennzeichen":"","fin":"","hsn":"","tsn":"","hersteller":"","modell":"","halter":"","erstzulassung":""}` },
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
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend (${MODEL}, build ${BUILD}) läuft auf Port ${PORT}`));
