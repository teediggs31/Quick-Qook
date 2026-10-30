// Quick Qook grocery scanner.
// Runs as a Vercel serverless function at /api/scan.
// Takes up to 4 photos (paper receipt, screenshot of a digital receipt or online order,
// or a photo of groceries, a fridge or a pantry shelf) and returns the food items it sees,
// each sorted onto a shelf. Uses your secret ANTHROPIC_API_KEY, like /api/recipes.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
// Reading store receipts takes a capable model. Change it in Vercel with QQ_SCAN_MODEL.
const SCAN_MODEL = process.env.QQ_SCAN_MODEL || 'claude-sonnet-5-5';

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGES = 4;
const MAX_BASE64 = 3_500_000; // about 2.6 MB per image after the browser shrinks it

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['receipt', 'order', 'groceries', 'fridge_or_pantry', 'not_food'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shelf: { type: 'string', enum: ['pantry', 'fridge', 'spices'] }
        },
        required: ['name', 'shelf'],
        additionalProperties: false
      }
    }
  },
  required: ['kind', 'items'],
  additionalProperties: false
};

const PROMPT = `These images are from someone's kitchen app. Each image is one of: a paper grocery receipt, a screenshot of a digital receipt or online grocery order, a photo of groceries, or a photo of a fridge, freezer, pantry or spice shelf.

List every food or cooking ingredient you can identify, so it can be added to their kitchen inventory.

Rules:
- Use short, plain, lowercase grocery names a home cook would use: "ground beef", "cheddar", "greek yogurt", "canned black beans", "spaghetti", "chili powder". No brands, sizes, weights, prices or quantities.
- Expand receipt abbreviations to the real item ("KRO GRND BF 80/20" means "ground beef", "BNLS SKNLS CHKN BRST" means "chicken breast", "GV SHRD CHDR" means "cheddar"). If an abbreviation is too unclear to decode with confidence, leave it out rather than guess.
- Skip anything that isn't food or a cooking ingredient: paper goods, cleaning supplies, toiletries, pet food, bags, taxes, discounts, totals, coupons. Skip drinks that aren't cooking ingredients (soda, energy drinks, bottled water); keep milk, broth, wine for cooking, and similar.
- List each item once, even if it appears several times or across several images.
- Shelf: "fridge" for produce, dairy, eggs, meat, seafood, deli, and anything frozen; "pantry" for grains, pasta, rice, bread, canned and jarred goods, baking supplies, snacks, oils, nuts; "spices" for spices, dried herbs, salt, sauces, condiments, dressings, vinegars, sweeteners like honey.
- "kind" describes the images overall. If they show no food at all, use "not_food" and return an empty items list.`;

function cleanImages(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_IMAGES) return null;
  const out = [];
  for (const img of list) {
    if (!img || !MEDIA_TYPES.includes(img.media_type) || typeof img.data !== 'string') return null;
    const data = img.data.replace(/^data:[^,]*,/, '');
    if (!data || data.length > MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
    out.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data } });
  }
  return out;
}

function parseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (err) {} }
  return null;
}

async function callClaude(key, request) {
  const upstream = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
    body: JSON.stringify(request)
  });
  const data = await upstream.json().catch(() => null);
  return { upstream, data };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'missing_key' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const images = cleanImages(body && body.images);
  if (!images) return res.status(400).json({ error: 'bad_images' });

  const request = {
    model: SCAN_MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: [...images, { type: 'text', text: PROMPT }] }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } }
  };
  try {
    let { upstream, data } = await callClaude(key, request);
    if (upstream.status === 400) {
      console.error('Scan 400 with structured output, retrying without it', data && data.error);
      const { output_config, ...plain } = request;
      plain.messages = [{ role: 'user', content: [...images, { type: 'text', text: PROMPT + '\n\nReply with only a JSON object: {"kind": "...", "items": [{"name": "...", "shelf": "pantry|fridge|spices"}]}' }] }];
      ({ upstream, data } = await callClaude(key, plain));
    }
    if (!upstream.ok) {
      console.error('Claude API error', upstream.status, data && data.error);
      if (upstream.status === 401 || upstream.status === 403) return res.status(500).json({ error: 'bad_key' });
      if (upstream.status === 429 || upstream.status === 529) return res.status(429).json({ error: 'rate_limited' });
      if (upstream.status === 413) return res.status(413).json({ error: 'too_large' });
      return res.status(502).json({ error: 'upstream_error', detail: 'status ' + upstream.status });
    }
    const text = ((data && data.content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    const result = parseJson(text);
    if (!result || !Array.isArray(result.items)) {
      console.error('Unreadable scan reply', data && data.stop_reason, text.slice(0, 500));
      return res.status(502).json({ error: 'invalid_json', detail: (data && data.stop_reason) || 'unknown' });
    }
    const seen = new Set(), items = [];
    for (const it of result.items) {
      const name = typeof (it && it.name) === 'string' ? it.name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40) : '';
      const shelf = ['pantry', 'fridge', 'spices'].includes(it && it.shelf) ? it.shelf : 'pantry';
      if (!name || seen.has(name)) continue;
      seen.add(name); items.push({ name, shelf });
    }
    return res.status(200).json({ result: { kind: result.kind || 'groceries', items: items.slice(0, 150) } });
  } catch (e) {
    console.error('Scan request failed', e);
    return res.status(502).json({ error: 'upstream_error' });
  }
};
