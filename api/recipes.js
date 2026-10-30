// Quick Qook recipe server.
// Runs as a Vercel serverless function at /api/recipes.
// It builds the prompt here (not in the browser) and calls the Claude API with your
// secret key, so the key never appears in the app's public code.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
// Fast, low-cost model for the list of ideas; a stronger model for full recipes.
// You can change either one in Vercel by adding QQ_IDEAS_MODEL or QQ_RECIPE_MODEL.
const IDEAS_MODEL = process.env.QQ_IDEAS_MODEL || 'claude-haiku-5-5';
const RECIPE_MODEL = process.env.QQ_RECIPE_MODEL || 'claude-sonnet-5-5';

const SHELVES = [['pantry', 'Pantry'], ['fridge', 'Fridge & freezer'], ['spices', 'Spice cabinet']];
const MEALS = ['Any', 'Breakfast', 'Lunch', 'Dinner', 'Snack', 'Dessert'];
const DIETS = ['Vegetarian', 'Vegan', 'Pescatarian', 'Gluten-free', 'Dairy-free', 'Nut-free', 'Egg-free', 'Low-carb', 'Keto', 'Halal'];
const CUISINES = ['American', 'BBQ', 'Southern', 'Mexican', 'Italian', 'Asian', 'Indian', 'Mediterranean', 'Middle Eastern', 'French'];
const METHODS = ['Stovetop', 'Oven', 'Grill', 'Blackstone', 'Smoker', 'Air fryer', 'Crockpot', 'Instant Pot', 'Microwave', 'No-cook'];
const METHOD_PROMPT = {
  'Stovetop': 'stovetop', 'Oven': 'oven', 'Grill': 'outdoor grill', 'Blackstone': 'Blackstone-style flat-top griddle',
  'Smoker': 'smoker', 'Air fryer': 'air fryer', 'Crockpot': 'slow cooker (Crockpot)',
  'Instant Pot': 'electric pressure cooker (Instant Pot)', 'Microwave': 'microwave', 'No-cook': 'no cooking at all'
};
const SLOW_METHODS = ['Crockpot', 'Smoker'];

/* ---------- input cleaning: never trust what the browser sends ---------- */
function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function strList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => str(x, maxLen)).filter(Boolean))].slice(0, maxItems);
}
function pick(list, v) { return Array.isArray(v) ? list.filter(x => v.includes(x)) : []; }
function num(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function cleanInput(body) {
  const k = body.kitchen || {}, p = body.prefs || {}, i = body.idea || {};
  const kitchen = {};
  for (const [key] of SHELVES) kitchen[key] = strList(k[key], 200, 40);
  const prefs = {
    meal: MEALS.includes(p.meal) ? p.meal : 'Any',
    time: num(p.time, 15, 65, 30),
    servings: num(p.servings, 1, 12, 2),
    extras: p.extras !== false,
    kids: p.kids === true,
    craving: str(p.craving, 80),
    avoid: str(p.avoid, 120),
    diets: pick(DIETS, p.diets),
    cuisines: pick(CUISINES, p.cuisines),
    methods: pick(METHODS, p.methods)
  };
  const idea = {
    title: str(i.title, 90),
    blurb: str(i.blurb, 240),
    minutes: num(i.minutes, 1, 1440, 0),
    method: METHODS.includes(i.method) ? i.method : ''
  };
  return { kitchen, prefs, idea, seen: strList(body.seen, 60, 90) };
}

/* ---------- prompts ---------- */
function kitchenText(k) {
  return SHELVES.map(([key, label]) => `${label}: ${k[key].join(', ') || '(nothing)'}`).join('\n') +
    '\nAlways available: water, salt, black pepper, cooking oil.';
}
function methodText(p) {
  if (!p.methods.length) return '';
  let t = `Cooking equipment: each recipe must be built around ${p.methods.map(m => METHOD_PROMPT[m]).join(' or ')}` +
    (p.methods.length > 1 ? ', spread across these.' : '.') + ' A quick supporting step on another appliance is fine only if unavoidable.';
  if (p.time < 65 && p.methods.some(m => SLOW_METHODS.includes(m))) {
    t += ' For slow cooker or smoker recipes, the time limit applies to hands-on prep only; unattended cooking can take hours. Report "minutes" as total time.';
  }
  return t;
}
function dietText(p) {
  const parts = [];
  if (p.kids) parts.push('Kid-friendly (strict): dishes children will happily eat. Keep them mild, not spicy (any heat goes on the side for adults), with familiar flavors, simple textures, and easy-to-eat, bite-size pieces. No alcohol. Avoid choking hazards for young kids, such as whole nuts or whole grapes.');
  if (p.diets.length) parts.push(`Dietary needs (strict): ${p.diets.join(', ')}. Every recipe and every ingredient must comply. Skip any of the cook's ingredients that break these needs, and never suggest a missing ingredient that breaks them. Watch for hidden sources (for example soy sauce and flour contain gluten, butter and cheese are dairy, honey is not vegan, broth may contain meat).`);
  if (p.avoid) parts.push(`Never use these, even if the cook has them: ${p.avoid}.`);
  return parts.join('\n');
}
function ideasPrompt({ kitchen, prefs: p, seen }) {
  const cuisineLine = p.cuisines.length
    ? `Cuisine: only ${p.cuisines.join(' or ')}. ${p.cuisines.length > 1 ? 'Spread the 5 dishes across these cuisines.' : 'All 5 dishes in this cuisine, varied in style.'}`
    : 'Make the 5 dishes varied in style and cuisine.';
  const avoid = seen.length ? `\nThe cook has already seen these, so suggest 5 new dishes that are clearly different from all of them: ${seen.join('; ')}.` : '';
  return `You are a practical home-cooking assistant. Suggest 5 recipes this cook can make right now from their kitchen.

${kitchenText(kitchen)}

Meal: ${p.meal === 'Any' ? 'any meal' : p.meal}.
Time: ${p.time >= 65 ? 'an hour or more is fine (no strict limit)' : 'at most ' + p.time + ' minutes total, prep included'}.
Servings: ${p.servings}.
${p.craving ? 'Craving: ' + p.craving + '.' : ''}
${methodText(p)}
${dietText(p)}
${p.extras ? 'Each recipe may need at most 2 ingredients that are not listed; list those under "missing". Prefer recipes that need none.' : 'Use only the listed ingredients (plus the always-available ones). "missing" must be an empty array.'}
${cuisineLine} Each should use several of the cook's ingredients.${avoid}

Reply with only a JSON object of the form {"recipes":[...]} holding 5 recipe objects shaped like:
{"title":"Cheesy Spinach Fried Rice","cuisine":"Asian","method":"Stovetop","blurb":"One sentence on what it is and why it's good.","minutes":20,"difficulty":"Easy","uses":["rice","eggs","spinach"],"missing":[]}
"cuisine" is a short label such as American, BBQ, Mexican, Italian, Asian. "method" is the main equipment, one of: ${METHODS.join(', ')}. "difficulty" is one of Easy, Medium, Hard. "uses" lists ingredient names exactly as they appear in the cook's lists.`;
}
function recipePrompt({ kitchen, prefs: p, idea }) {
  return `Write a complete, reliable home recipe for "${idea.title}"${idea.blurb ? ' (' + idea.blurb + ')' : ''}.

The cook has:
${kitchenText(kitchen)}

Serves ${p.servings}.${idea.minutes ? ' Aim for about ' + idea.minutes + ' minutes total.' : ''}
${idea.method ? 'Cook it with: ' + METHOD_PROMPT[idea.method] + '. Give temperatures and settings for that equipment.' : ''}
${dietText(p)}
${p.extras ? "Use the cook's ingredients wherever possible; at most 2 ingredients may be ones they don't have." : "Use only the cook's ingredients and the always-available ones."}
Use US kitchen measurements (cups, tbsp, tsp, oz, lb, cloves, pieces).

Reply with only a JSON object shaped like:
{"title":"string","servings":${p.servings},"minutes":25,"difficulty":"Easy","ingredients":[{"item":"long-grain rice","amount":"1 cup","have":true}],"steps":["Rinse the rice until the water runs clear."],"tip":"One practical tip."}
"have" is true when the item is in the cook's lists or always available, false otherwise. Steps are in order, clear and specific (heat levels, times, doneness cues), with no numbering in the text.`;
}

/* ---------- the JSON shapes Claude must return ---------- */
const STR = { type: 'string' };
const STR_LIST = { type: 'array', items: STR };
const DIFFICULTY = { type: 'string', enum: ['Easy', 'Medium', 'Hard'] };
function obj(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const IDEAS_SCHEMA = obj({
  recipes: {
    type: 'array',
    items: obj({ title: STR, cuisine: STR, method: STR, blurb: STR, minutes: { type: 'integer' }, difficulty: DIFFICULTY, uses: STR_LIST, missing: STR_LIST })
  }
});
const RECIPE_SCHEMA = obj({
  title: STR, servings: { type: 'integer' }, minutes: { type: 'integer' }, difficulty: DIFFICULTY,
  ingredients: { type: 'array', items: obj({ item: STR, amount: STR, have: { type: 'boolean' } }) },
  steps: STR_LIST, tip: STR
});

async function callClaude(key, request) {
  const upstream = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
    body: JSON.stringify(request)
  });
  const data = await upstream.json().catch(() => null);
  return { upstream, data };
}

/* ---------- reading Claude's reply ---------- */
// Finds the first complete JSON object or array in the text, even with words around it.
function firstBalanced(t) {
  for (let s = 0; s < t.length; s++) {
    if (t[s] !== '{' && t[s] !== '[') continue;
    const stack = []; let inStr = false, esc = false;
    for (let i = s; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const open = stack.pop();
        if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) break;
        if (!stack.length) { try { return JSON.parse(t.slice(s, i + 1)); } catch (e) { break; } }
      }
    }
  }
  return null;
}
function parseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  return firstBalanced(t);
}

/* ---------- the endpoint ---------- */
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
  if (!body || (body.type !== 'ideas' && body.type !== 'recipe')) return res.status(400).json({ error: 'bad_request' });

  const input = cleanInput(body);
  const count = SHELVES.reduce((n, [k]) => n + input.kitchen[k].length, 0);
  if (count < 1) return res.status(400).json({ error: 'bad_request' });
  if (body.type === 'recipe' && !input.idea.title) return res.status(400).json({ error: 'bad_request' });

  const isIdeas = body.type === 'ideas';
  const request = {
    model: isIdeas ? IDEAS_MODEL : RECIPE_MODEL,
    // Generous ceiling: you only pay for tokens actually used, and newer models may think before answering.
    max_tokens: isIdeas ? 8000 : 12000,
    messages: [{ role: 'user', content: isIdeas ? ideasPrompt(input) : recipePrompt(input) }],
    // Structured outputs: Claude's reply is guaranteed to match this JSON shape.
    output_config: { format: { type: 'json_schema', schema: isIdeas ? IDEAS_SCHEMA : RECIPE_SCHEMA } }
  };
  try {
    let { upstream, data } = await callClaude(key, request);
    // If this model or account doesn't accept structured outputs, retry once without it.
    if (upstream.status === 400) {
      console.error('Claude API 400 with structured output, retrying without it', data && data.error);
      const { output_config, ...plain } = request;
      ({ upstream, data } = await callClaude(key, plain));
    }
    if (!upstream.ok) {
      console.error('Claude API error', upstream.status, data && data.error);
      if (upstream.status === 401 || upstream.status === 403) return res.status(500).json({ error: 'bad_key' });
      if (upstream.status === 429 || upstream.status === 529) return res.status(429).json({ error: 'rate_limited' });
      return res.status(502).json({ error: 'upstream_error', detail: 'status ' + upstream.status });
    }
    const text = ((data && data.content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    const result = parseJson(text);
    if (result == null) {
      const types = ((data && data.content) || []).map(b => b && b.type).join(',') || 'none';
      console.error('Unreadable reply', data && data.stop_reason, types, text.slice(0, 500));
      return res.status(502).json({ error: 'invalid_json', detail: `${(data && data.stop_reason) || 'unknown'}; blocks: ${types}` });
    }
    return res.status(200).json({ result });
  } catch (e) {
    console.error('Recipe request failed', e);
    return res.status(502).json({ error: 'upstream_error' });
  }
};
