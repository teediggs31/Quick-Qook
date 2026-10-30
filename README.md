# Quick Qook

Tell it what's in your kitchen. Get dishes you can cook tonight.

Quick Qook lets you list what's in your pantry, fridge, and spice cabinet, set filters (meal, type of food, cooking method, dietary needs, time, servings), and get recipe ideas built from what you already have. Recipes come from Claude through a small server function, so your API key stays private.

## What's in this project

| File | What it does |
|---|---|
| `index.html` | The app people see and use. Saves each person's kitchen and saved recipes in their own browser. |
| `api/recipes.js` | The recipe server. Builds the request and calls the Claude API using your secret key. |
| `vercel.json` | Gives the recipe server up to 60 seconds per request. |
| `manifest.webmanifest`, `icons/` | Lets people add Quick Qook to their phone's home screen like an app. |

## Setup

1. **Upload to GitHub.** Create a repository and upload every file and folder here (keep the `api` and `icons` folders).
2. **Get a Claude API key.** Create an account at [platform.claude.com](https://platform.claude.com), add billing, and create a key under Settings → API keys. Set a monthly spend limit while you're there.
3. **Deploy on Vercel.** Sign in at [vercel.com](https://vercel.com) with GitHub, click **Add New → Project**, and import this repository. Leave the build settings as they are.
4. **Add your key.** Before deploying (or afterward, in Settings → Environment Variables), add a variable named `ANTHROPIC_API_KEY` with your key as the value. If you add it after deploying, redeploy from the Deployments tab.
5. **Open your link.** Vercel gives you an address like `quick-qook.vercel.app`.

## Updating the app

Change a file on GitHub (or upload a new version) and commit. Vercel redeploys automatically within a minute.

## Optional settings

Add these environment variables in Vercel to change which Claude model is used:

- `QQ_IDEAS_MODEL`, the model for the list of ideas (default: `claude-haiku-5-5`, fast and low cost)
- `QQ_RECIPE_MODEL`, the model for full recipes (default: `claude-sonnet-5-5`)

## Good to know

- Anyone with your link can use the app, and each search uses your API credit. A spend limit in the Claude Console keeps costs predictable.
- Never put your API key in `index.html` or any file on GitHub. It belongs only in Vercel's environment variables.
- AI-written recipes can make mistakes. Check labels for allergens, and cook meat to safe temperatures.
