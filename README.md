# Jev Playground (unofficial)

A small web app for trying TypeSafe's Jev API with your own API key. Paste a "state" (some text or JSON), define a few questions, and see how Jev answers.

This is an unofficial project, not affiliated with or endorsed by TypeSafe AI. It is a plain static site plus one small server function. No framework, no build step, no npm dependencies.

## How keys are handled

Every visitor uses their own TypeSafe API key. This app does not hold a shared key.

- Your key is typed into the page and kept in this browser tab (sessionStorage by default). Checking "Remember on this device" also saves it to localStorage on your own device, and you can clear it any time with "Forget key."
- Each run sends your key over HTTPS to this site's own relay endpoint, which adds it to the request to TypeSafe and forwards the response back. The relay never writes the key to a log, a file, a database, or a response body.
- The relay only accepts requests from this site's own origin, so other websites can't use it to send traffic to TypeSafe under your key.
- The relay applies a basic per-IP rate limit and a body size limit, and retries TypeSafe's transient errors (429, 529) with backoff.

That said: you are trusting whoever runs this relay (the deployment you're using) with your key for the moment it passes through. The code is open here, so you can read exactly what it does, or run your own copy instead of trusting someone else's deployment. If you'd rather not trust any relay, self-host it.

## Run locally

```
npm start
```

Then open http://localhost:4747. Paste your TypeSafe key into the API key field at the top of the page. No `.env` file or environment variable is needed for this version, since keys come from each visitor, not from the server.

## Deploy

```
vercel --prod
```

Live at https://jev-playground-beta.vercel.app.

The local dev server lives in `scripts/` and `.vercelignore` keeps it out of deploys. Vercel treats a root-level `server.mjs` as the whole app, which hides `public/` and `api/`.

The project deploys as a static site (`public/`) plus one serverless function (`api/run.mjs`). No project-level environment variables are required.
