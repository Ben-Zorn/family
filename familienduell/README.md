# Familien-Duell (Family Feud for your group)

Static website, no server, no login. 1 laptop (board + game master) + 2 phones (buzzers).

## Hosting for free (no credit card)

**GitHub Pages** (recommended)
1. Create a free account at github.com (email only).
2. New repository → e.g. `familienduell` → **Public**.
3. "Add file" → "Upload files" → drag in *the contents of the `site` folder* (not `src`!) → Commit.
4. Settings → Pages → Source: "Deploy from a branch", Branch: `main` / `(root)` → Save.
5. After ~1 minute it's live at `https://<your-username>.github.io/familienduell/`.

**Alternative: Netlify Drop** – go to app.netlify.com/drop, drag the `site` folder in, done.

Opening `host.html` straight from disk (file://) won't work – it has to be served via https.

## Password

Every page first shows a password screen (password: `fuerte`). Before it's entered, the browser only loads an empty page and
the small `gate.js` – no questions, no app code, no styles, no PeerJS, no Google Fonts. Everything else is in `site/app.enc`,
encrypted with AES-256-GCM (key from the password via PBKDF2, 300 000 rounds), and is only downloaded after you submit the password.
Each device remembers the password, so phones only type it once.

Limits: this is a static site, so `app.enc` itself is publicly downloadable – just unreadable without the password. A short
lowercase password like `fuerte` would not stop someone determined who brute-forces it offline; for a vacation game that's fine.

Folder layout: `site/` = what you upload. `src/` = readable source. To change questions or the password, edit `src/` and run
`node build.js <password>` (needs Node.js) – it rewrites `site/`.

## Playing

1. Laptop: open the site → **Spielleitung**. Top left shows a 4-letter room code.
2. Click **📱 Buzzer** → scan the QR code for Team A with phone 1, Team B with phone 2.
3. On the top bar you'll see each buzzer with ping and sync accuracy.
4. **Neue Frage** (N) → read the question → **Buzzer freigeben** (Space).
   Phones turn yellow ("Achtung"), then after a random 1–2.5 s both turn green at the same moment. Fastest reaction wins.
5. Reveal answers with buttons or keys **1–8**, wrong answer **X**, set who plays (**Team … spielt**).
   3 strikes → steal phase automatically. Revealing an answer during the steal = steal succeeds; X = steal fails.
   All answers found → points go to the playing team automatically.
6. **Rest aufdecken** shows the remaining answers (no points). Then **Neue Frage**.

| Key | Action |
|---|---|
| N | New question |
| S | Skip question |
| Space / Esc | Release / lock buzzers |
| 1–8 | Reveal answer |
| X | Strike |
| H (hold) | Peek at the answers in the GM panel |
| Z | Undo |

**Game master on the same screen as players:** answers in the GM panel are hidden; hold **H** (or the 👁 button) to peek.
If you can connect the laptop to a TV: click **🖥 Board-Fenster**, drag that window to the TV and double-click for fullscreen –
the laptop then shows the GM panel with all answers visible.

**Questions:** 400 German survey questions in 15 categories, three tones (Familienfreundlich / Frech / Erwachsene).
Under **🗂 Fragen** you can switch categories and tones on/off. Played and skipped questions never come back unless you reset
them there (individually, only skipped ones, or all). This is stored in the laptop's browser – use the same laptop/browser all vacation.

Settings (⚙): team names, buzzer mode (random delay vs. immediate), false-start penalty, show question on board, new game.
Score and game state survive a page reload.

## How the fair buzzing works

1. **Clock sync (NTP-style):** each phone pings the laptop continuously (burst of 20 on connect, then every 0.4 s).
   For every ping: `rtt = (t3−t0) − (t2−t1)`, `offset = ((t1−t0) + (t2−t3)) / 2`.
   The offset estimate is the median of the 30 % lowest-RTT samples of the last 20 s (minimum-delay filter – low-RTT
   samples are the least distorted by queueing/Wi-Fi retries).
2. **Scheduled GO:** "Buzzer freigeben" picks a GO instant in the *future* on the laptop's clock (at least 1.5× the worst ping
   + 200 ms ahead). Each phone converts it to its own clock and turns green at that exact moment. In tests with 25 ms vs. 150 ms
   ping (+ jitter), both phones showed GO within ±2 ms of each other.
3. **Reaction time decides:** each phone measures `touch time − moment GO was drawn` using the touch event's own timestamp.
   The laptop compares reaction times, so network delay never decides who was first – it only has to be shorter than the lead time.
   The laptop waits briefly for the second buzz (and corrects the result if a faster buzz arrives late).
4. **False starts:** pressing while yellow locks that buzzer for 1 s (configurable); its reaction time still counts from the real GO.

Remaining unfairness is hardware only (touchscreen/display latency, ~10–30 ms between phone models). If you want to rule that
out too, swap phones between rounds.

## Network notes

- Uses WebRTC via PeerJS. The free PeerJS cloud server is only needed to *set up* the connection; the buzzer data then flows
  directly between the devices. So you need some internet at setup; best is all devices on the same Wi-Fi (or the laptop's/a phone's hotspot).
- Keep the buzzer pages in the foreground with the screen on (the page asks for a wake lock after the first tap).
- If a buzzer shows "Offline", it reconnects by itself; reloading the page also works.
