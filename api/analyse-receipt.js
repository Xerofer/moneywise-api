// api/analyse-receipt.js
// Vercel serverless function — receives base64 image, calls Gemini, returns JSON

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELS = [
  'gemini-2.0-flash',              // stable, has free tier
  'gemini-2.5-flash-lite-preview', // newer free lite
  'gemini-3-flash-preview',        // newest free
];
const BASE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const CATEGORIES = [
  'Food','Groceries','Transport','Shopping','Health','Entertainment',
  'Bills','Housing','Travel','Education','Subscriptions','Utilities',
  'Fitness','Savings','Investments','Gifts','Pets','Other',
];

const PROMPT = `You are a receipt parser. Analyse this receipt image and extract every individual line item with its price.

Rules:
- The receipt can be in ANY language — always respond in English.
- Include ALL items, even if the receipt is partially cut off or blurry.
- Do NOT include subtotals, taxes, tips, discounts, or the grand total as separate items.
- If a quantity > 1 is shown (e.g. "2 x Coffee 3.00"), list as one item with the total line price.
- Round all amounts to 2 decimal places.
- Assign exactly one category from: ${CATEGORIES.join(', ')}
- Use "Other" only when no other category fits.

Respond ONLY with a valid JSON array — no explanation, no markdown, no code fences.
Each element must have exactly these three keys:
  "name"     : string  — short English description
  "amount"   : number  — price as decimal
  "category" : string  — one of the categories above

Example:
[{"name":"Cappuccino","amount":3.50,"category":"Food"},{"name":"Paracetamol","amount":2.99,"category":"Health"}]`;

export default async function handler(req, res) {
  // CORS — allow your Flutter app from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, mimeType } = req.body ?? {};
  if (!image || !mimeType) {
    return res.status(400).json({ error: 'Missing image or mimeType' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  console.log('[Debug] Key prefix:', GEMINI_API_KEY.substring(0, 8));
  console.log('[Debug] Key length:', GEMINI_API_KEY.length);

  try {
    // Try each model until one works
    let geminiRes, lastErr;
    for (const model of MODELS) {
      try {
        geminiRes = await fetch(`${BASE_ENDPOINT}/${model}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: image } },
            { text: PROMPT },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    });

        if (geminiRes.ok) break; // success — stop trying
        lastErr = await geminiRes.json().catch(() => ({}));
        console.log(`[Receipt] Model ${model} failed: ${geminiRes.status}`);
      } catch(e) { lastErr = e; }
    }

    if (!geminiRes?.ok) {
      const msg = lastErr?.error?.message ?? `Gemini error ${geminiRes?.status}`;
      return res.status(500).json({ error: msg });
    }

    const data = await geminiRes.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    text = text.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').trim();

    // Validate it's a JSON array
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Response is not an array');

    // Sanitise items
    const items = parsed
      .filter(i => i?.name && typeof i.amount === 'number' && i.amount > 0)
      .map(i => ({
        name:     String(i.name).trim(),
        amount:   Math.round(i.amount * 100) / 100,
        category: CATEGORIES.includes(i.category) ? i.category : 'Other',
      }));

    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message ?? 'Parse error' });
  }
}
