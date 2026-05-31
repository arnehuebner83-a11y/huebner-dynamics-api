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
              text: 'Du siehst eine deutsche Zulassungsbescheinigung Teil I. Extrahiere folgende Felder als JSON. Wenn nicht erkennbar, verwende leeren String.\n{"kennzeichen":"Kennzeichen (Feld I)","fin":"FIN 17 Zeichen (Feld E)","hsn":"HSN 4 Ziffern (Feld 2.1)","tsn":"TSN (Feld 2.2)","hersteller":"Hersteller (Feld D.1)","modell":"Modell (Feld D.3)","halter":"Name Halter (Feld C.1)","erstzulassung":"Datum Erstzulassung (Feld B)"}\nNur JSON, keine Erklärung.',
            },
          ],
        },
      ],
    });

    const raw = response.content[0]?.text || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    res.json({
      success: true,
      kennzeichen: parsed.kennzeichen || '',
      fin: parsed.fin || '',
      hsn: parsed.hsn || '',
      tsn: parsed.tsn || '',
      hersteller: parsed.hersteller || '',
      modell: parsed.modell || '',
      halter: parsed.halter || '',
      erstzulassung: parsed.erstzulassung || '',
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
