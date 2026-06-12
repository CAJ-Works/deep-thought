# Deep Thought: Personal Capture & Cognitive Enrichment Console

Deep Thought is a private, self-hosted web console and background cognitive pipeline designed to run on a local Mac Mini. It allows you to instantly capture thoughts via text or voice, tags your location, and runs background enrichment workers using local models (LM Studio), the Gemini API, and web crawls to categorize, contextualize, and link your ideas into an evolving semantic network.

It also synchronizes your thoughts with Google Keep under a `#deep-thought` label.

---

## Technical Architecture

```
[ Internet Client ] ◄──► [ Cloudflare Tunnel ] ◄──► [ Docker Stack: FastAPI & SQLite ]
                                                           │
                                                           ├──► [ Gemini Cloud API ] (Transcription)
                                                           │
                                                           └──► [ LM Studio Native macOS ] (Inference)
                                                                 (Metal/GPU Accelerated)
```

- **Frontend:** Responsive HTML5, Vanilla ES6 JavaScript, and Vanilla CSS (Glassmorphism theme) with browser-native Web Audio recording and a dynamic HTML5 Canvas force-directed graph physics solver.
- **Backend:** FastAPI (Python 3.9) exposing endpoint APIs, managing database transactions, and running asynchronous tasks.
- **Database:** SQLite for lightweight, fast, file-based persistence.
- **AI Router:** Integrates local hardware-accelerated models via **LM Studio** and the **Gemini API** for high-fidelity text synthesis and audio transcriptions.
- **Worker Daemon:** Backed by `APScheduler`, running check-ups every 2 hours and deep contextual crawls nightly at 2:00 AM.

---

## Key Features

1. **Snappy Capture:** A fixed top-panel input for instant text thoughts.
2. **Audio Transcription:** Record voice notes using the browser microphone with a real-time canvas waveform visualizer. Audio is transcribed via the Gemini 1.5 Flash API.
3. **Location Tagging:** Captures browser GPS coordinates and appends location tags (e.g., neighborhood or coordinates) to entries.
4. **Subdomain Multi-User Support:** Detects user contexts dynamically based on the incoming subdomain (e.g. `chris.teamjames.cc` routes to Chris's database, while `brandon.teamjames.cc` routes to Brandon's database).
5. **PIN Pad Security & Lockout:** A numeric keypad overlay locks the screen. 3 incorrect PIN inputs lock the account for 90 seconds. 
6. **Trusted Devices:** "Remember this device" checkbox saves a cryptographically signed secure session cookie valid for 30 days.
7. **Semantic Connecting:** Background worker auto-detects keywords and common contexts to link related thoughts (e.g., automatically linking *"turtle baseball"* to last week's *"alligator soccer"*).
8. **Nightly Web Research:** Crawler generates search queries for thoughts, searches DuckDuckGo, and appends context links and summary snippets.

---

## Pre-requisites

- **Mac Mini** running macOS.
- **Docker** & **Docker Compose** installed (via Docker Desktop or OrbStack).
- **LM Studio** installed and running on the Mac Mini.
- A **Gemini API Key** (generate one for free/low-cost at Google AI Studio).
- A **Cloudflare Account** and a configured custom domain (e.g., `teamjames.cc`) with a Cloudflare Tunnel setup.

---

## Installation & Configuration Guide

### 1. Configure the Local LM Studio
To ensure the local models run with Apple Silicon GPU acceleration (Metal), LM Studio must run natively on the macOS host, not inside a container:
1. Open **LM Studio**.
2. Download your preferred model (e.g., `meta-llama-3-8b-instruct` or any lightweight instruction-tuned model).
3. Navigate to the **Local Server** tab (the double-arrows icon in the left sidebar).
4. Select your model, set the port to `1234`, and click **Start Server**.
5. Keep LM Studio running in the background.

---

### 2. Configure Environment Settings
1. Navigate to the project folder on your Mac Mini:
   ```bash
   cd /Users/ms1/Code/deep-thought
   ```
2. Create and open your `.env` configuration file:
   ```bash
   nano .env
   ```
3. Populate the configurations:
   ```env
   # Server settings
   PORT=8000
   DATABASE_URL=sqlite:///./data/deep_thought.db
   JWT_SECRET=use_a_secure_custom_random_string_here

   # Cloudflare Tunnel Configuration
   CLOUDFLARE_TUNNEL_TOKEN=your_cloudflare_tunnel_token_here

   # LM Studio settings (points to host macOS via Docker host bridge)
   LM_STUDIO_BASE_URL=http://host.docker.internal:1234/v1
   LM_STUDIO_MODEL=meta-llama-3-8b-instruct

   # Gemini API Key (Needed for transcription)
   GEMINI_API_KEY=your_gemini_api_key_here

   # User Keep Sync Configurations (Optional)
   KEEP_USERNAME_CHRIS=chris@gmail.com
   KEEP_PASSWORD_CHRIS=your_google_app_password

   KEEP_USERNAME_BRANDON=brandon@gmail.com
   KEEP_PASSWORD_BRANDON=your_google_app_password
   ```
   *Note: If you use Google Keep sync, you must create a Google App Password (not your primary password) under your Google account security settings.*

---

### 3. Initialize & Seed the SQLite Database
A script is provided to initialize the database tables and seed default user accounts:
1. Create a local python virtualenv and install requirements to run the seed script:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install --upgrade pip
   pip install -r requirements.txt
   ```
2. Seed the user databases (default PINs are `1234` for `chris` and `5678` for `brandon`):
   ```bash
   python3 seed_users.py
   ```
   *Note: To change default PINs or usernames, edit [seed_users.py](file:///Users/ms1/Code/deep-thought/seed_users.py).*

---

### 4. Deploy the Container Stack
Start the backend application container and the Cloudflare Tunnel agent:
```bash
docker-compose up -d --build
```
This builds your FastAPI web server and launches a sidecar container running `cloudflared`.

To verify both containers are running cleanly:
```bash
docker ps
```
You should see:
- `deep-thought-app` running on port `8000`.
- `deep-thought-tunnel` running the Cloudflare connector.

---

### 5. Set up Cloudflare Tunnel Subdomain Routing
To allow you to go to `chris.teamjames.cc` and your son to `brandon.teamjames.cc`:
1. Log in to the [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Access** ──► **Tunnels**.
3. Select your tunnel and click **Configure**.
4. Go to the **Public Hostname** tab and click **Add a public hostname**.
5. Configure the first entry:
   - **Subdomain:** `chris`
   - **Domain:** `teamjames.cc`
   - **Type:** `HTTP`
   - **URL:** `http://app:8000` (pointing to the backend service container name)
6. Click **Save hostname**.
7. Repeat the steps to add the Brandon subdomain:
   - **Subdomain:** `brandon`
   - **Domain:** `teamjames.cc`
   - **Type:** `HTTP`
   - **URL:** `http://app:8000`
8. Cloudflare will automatically provision SSL certificates for both domains.

Accessing `chris.teamjames.cc` and `brandon.teamjames.cc` in your browser will now route you directly to the PIN console for the respective user account!

---

## Verifying & Testing

A local test script is provided to verify authentication logic and multi-user database scoping. Run it using:
```bash
./venv/bin/python3 -m unittest test_app.py
```
Outputs should show all tests passing cleanly (`OK`).
