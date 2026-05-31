import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.post('/api/scan-fahrzeugschein', async (req, res) => {
  try {
    const { b64 } = req.body;
    if (!b64) throw new Error('Kein Bild vorhanden');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: b64,
              },
            },
            {
              type: 'text',
              text: `Deutsche Zulassungsbescheinigung Teil I (Fahrzeugschein). EXTRAHIERE EXAKT DIESE FELDER:

REGELN:
- NUR valide Daten eintragen
- Bei Unsicherheit: LEER LASSEN ""
- Keine "Best Guess"

FELDER:
1. kennzeichen: Deutsches Nummernschild Format "AB-CD 123" oder "AB CD 123" (oben links, Feld I)
2. fin: EXAKT 17 alphanumerisch (Feld E, VIN)
3. hsn: EXAKT 4 Ziffern (Feld 2.1, Herstellerschlüsselnummer)
4. tsn: 3-8 Zeichen (Feld 2.2, Typschlüsselnummer) 
5. hersteller: Hersteller name (Feld D.1)
6. modell: Modell/Baureihe (Feld D.3)
7. halter: Name Halter (Feld C.1.1-C.1.3)
8. erstzulassung: Datum TT.MM.YYYY (Feld B, erste Zulassung)

WICHTIG:
- Kennzeichen: Nur wenn 2-3 Buchstaben + 1-2 Buchstaben + 1-4 Ziffern
- HSN: Nur wenn exakt 4 Ziffern, keine Buchstaben
- TSN: Alphanumerisch, max 8 Zeichen
- FIN: Nur wenn exakt 17 Zeichen
- Wenn unsicher → leerer String ""

Ausgabe NUR JSON, keine Erklärung:
{"kennzeichen":"","fin":"","hsn":"","tsn":"","hersteller":"","modell":"","halter":"","erstzulassung":""}`,
            },
          ],
        },
      ],
    });

    const raw = response.content[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      parsed = {};
    }

    // Validierung
    const validated = {
      kennzeichen: (parsed.kennzeichen || '').trim(),
      fin: (parsed.fin || '').trim(),
      hsn: (parsed.hsn || '').trim(),
      tsn: (parsed.tsn || '').trim(),
      hersteller: (parsed.hersteller || '').trim(),
      modell: (parsed.modell || '').trim(),
      halter: (parsed.halter || '').trim(),
      erstzulassung: (parsed.erstzulassung || '').trim(),
    };

    res.json({
      success: true,
      ...validated,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend läuft auf Port ${PORT}`);
});
