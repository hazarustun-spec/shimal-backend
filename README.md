# Shimal Backend

Backend that calculates real astrological data using Swiss Ephemeris and generates personalized daily insights using Google Gemini.

Built on Node's built-in `node:http` module — there is no Express dependency, so routes are plain `[method, pathRegex, handler]` tuples registered in `src/index.js`.

## Quick Start

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```
Then open `.env` and fill in your API keys:
- **SUPABASE_URL** + **SUPABASE_SERVICE_KEY**: From Supabase dashboard → Settings → API
- **GEMINI_API_KEY**: From aistudio.google.com → API Keys. Required — the
  server refuses to boot without it (`src/index.js:26`).
- **ONESIGNAL_APP_ID** + **ONESIGNAL_API_KEY**: From OneSignal dashboard (optional for dev)

### 3. Set up the database
Go to your Supabase project → SQL Editor → paste and run the SQL from `docs/database-schema.sql`.

### 4. Run the server
```bash
npm run dev
```

## Testing with curl

```bash
# Health check
curl http://localhost:3000/health

# Real planetary transits right now
curl http://localhost:3000/api/transits/today

# Register a user
curl -X POST http://localhost:3000/api/user/register \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-123","birthDate":"1995-03-15","birthTime":"14:30","gender":"female","relationshipStatus":"single","workStatus":"employed"}'

# Get daily insight
curl http://localhost:3000/api/daily/test-123
```
