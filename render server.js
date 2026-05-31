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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: `Deutsche Zulassungsbescheinigung Teil I (Fahrzeugschein). EXTRAHIERE EXAKT DIESE FELDER:

REGELN:
- NUR valide Daten eintragen
- Bei Unsicherheit: LEER LASSEN ""
- Keine "Best Guess"

FELDER:
1. kennzeichen: Deutsches Nummernschild "AB-CD 123" (oben links, Feld I) - NICHT die Nummer oben rechts (das ist die Zulassungsnummer)
2. fin: EXAKT 17 Zeichen (Feld E, VIN)
3. hsn: EXAKT 4 Ziffern (Feld 2.1, Herstellerschlüsselnummer)
4. tsn: 3 Zeichen Buchstaben/Ziffern (Feld 2.2, Typschlüsselnummer)
5. hersteller: Hersteller (Feld D.1, z.B. BMW)
6. modell: Typ/Variante (Feld D.3)
7. halter: Name Person (Feld C.1.1 Nachname + C.1.2 Vorname)
8. erstzulassung: Datum TT.MM.YYYY (Feld B)

WICHTIG:
- HSN ist IMMER genau 4 Ziffern (z.B. 0005)
- Feld 2.1 und 2.2 stehen oben, direkt nach dem Erstzulassungsdatum
- Bei Unsicherheit → leerer String ""

Ausgabe NUR JSON:
{"kennzeichen":"","fin":"","hsn":"","tsn":"","hersteller":"","modell":"","halter":"","erstzulassung":""}` },
        ],
      }],
    });

    const raw = response.content[0]?.text || '{}';
    let p;
    try { p = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (e) { p = {}; }

    // Validierung & Bereinigung
    const fin = (p.fin || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
    const hsn = (p.hsn || '').replace(/[^0-9]/g, '').slice(0, 4);   // HSN: nur 4 Ziffern
    const tsn = (p.tsn || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 7); // TSN: max 7 alphanum

    res.json({
      success: true,
      kennzeichen: (p.kennzeichen || '').trim(),
      fin: fin.length === 17 ? fin : '',  // nur wenn exakt 17
      hsn,
      tsn,
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
