import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/scan-fahrzeugschein', async (req, res) => {
  try {
    const { b64 } = req.body;
    if (!b64) throw new Error('Kein Bild vorhanden');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: `Du bist Experte für deutsche Zulassungsbescheinigungen Teil I (Fahrzeugscheine). Lies das Bild SEHR GENAU.

WICHTIG - Layout des Fahrzeugscheins:
- OBEN LINKS steht "Zulassungsbescheinigung Teil I" und darunter eine Nr. wie "HP-K-1-035/25-00024" (das ist NICHT das Kennzeichen!)
- Das KENNZEICHEN steht im Feld A "Amtliches Kennzeichen", meist in einem Kasten, Format wie "KH M789" oder "M-AB 1234"
- GANZ OBEN in der mittleren Spalte: Datum (Feld B, z.B. 30.09.2016), direkt rechts daneben kleine Zahl "2.1" mit 4 Ziffern (HSN), dann "2.2" mit Code (TSN)

EXTRAHIERE (lies jeden Wert ZEICHEN FÜR ZEICHEN):

1. kennzeichen: Feld A, amtliches Kennzeichen (z.B. "KH M789"). NICHT die Nr oben links!
2. fin: Feld E, exakt 17 Zeichen (Fahrgestellnummer/VIN)
3. hsn: Feld 2.1, GENAU 4 Ziffern (Herstellerschlüsselnummer, z.B. "0005")
4. tsn: Feld 2.2, der Code rechts neben 2.1 (z.B. "BVZ00047X" oder "AE 123")
5. hersteller: Feld D.1 (z.B. "BMW") oder Feld 2/Hersteller-Klartext (z.B. "BAYER.MOT.WERKE-BMW")
6. modell: Feld D.3 (Handelsbezeichnung, z.B. "430D")
7. halter: Feld C.1.1 (Name) + C.1.2 (Vorname), zusammen (z.B. "Gräfin zu Münster Astrid")
8. erstzulassung: Feld B, Datum erste Zulassung (TT.MM.JJJJ)

REGELN:
- Lies NUR was wirklich dasteht, errate NICHTS
- HSN = immer exakt 4 Ziffern
- Wenn ein Feld nicht sicher lesbar: leerer String ""

Antworte NUR mit JSON:
{"kennzeichen":"","fin":"","hsn":"","tsn":"","hersteller":"","modell":"","halter":"","erstzulassung":""}` },
        ],
      }],
    });

    const raw = response.content[0]?.text || '{}';
    let p;
    try { p = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (e) { p = {}; }

    const fin = (p.fin || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
    const hsn = (p.hsn || '').replace(/[^0-9]/g, '').slice(0, 4);

    res.json({
      success: true,
      kennzeichen: (p.kennzeichen || '').trim(),
      fin: fin.length === 17 ? fin : '',
      hsn,
      tsn: (p.tsn || '').trim().slice(0, 10),
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
app.listen(PORT, () => console.log(`Backend läuft auf Port ${PORT}`));
