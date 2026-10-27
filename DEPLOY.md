# Putting Prime Time Online on the internet

Prime Time Online is **one Node.js web service**. The same port serves the web page and the live game traffic (WebSockets through Socket.IO). There is no database. Games live in the server's memory, and teacher accounts are kept in a small JSON file.

## The short version

1. Use a host that can run a long-lived **Node.js 20+** process with **WebSockets**: a VPS, Docker, or Render/Railway/Fly.io. Shared PHP/cPanel hosting will not work.
2. Run `npm ci --omit=dev`, then `npm start` (or use the Dockerfile).
3. Put it behind **HTTPS**, and set the environment variables below (at least `DATA_DIR`, `TRUST_PROXY` and `ADMIN_SIGNUP_CODE`; for "Forgot password?" emails also `PUBLIC_URL` and the `SMTP_` settings).
4. Run **exactly one instance**, and give `DATA_DIR` **storage that survives redeploys**.

## What the server needs

| | |
|---|---|
| **Node.js** | 20 or newer (the email library needs it). |
| **WebSockets** | The host or reverse proxy must allow WebSocket upgrades (see the nginx example). Socket.IO falls back to long-polling if they are blocked, but WebSockets are much better. |
| **HTTPS** | Required in practice: teachers type a password, and the "Invite a friend" share sheet and copy-link need HTTPS (without it the link is only shown on screen). |
| **One instance only** | Games are kept in memory. Two copies behind a load balancer would split players between them. Don't scale it out. |
| **Persistent storage** | `DATA_DIR` holds `admins.json` (teacher accounts, passwords hashed with scrypt) and `secret.key` (signs teacher log-ins). If it is lost, every teacher has to sign up again. Back it up. |
| **Restarts** | A restart or redeploy ends the games in progress (players see "That game has ended"). Teacher accounts are not affected. Deploy when nobody is playing. |
| **Size** | Tiny. The smallest VPS or instance is plenty. |

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Most managed hosts set it for you. |
| `DATA_DIR` | `./data` | Folder for teacher accounts and the sign-in key. Point it at persistent storage. |
| `TRUST_PROXY` | (off) | Set to `1` when the app sits behind one reverse proxy (nginx, Render, Railway, Fly.io…). The log-in limit (10 tries a minute per address) then counts each visitor's real address. Without it, all teachers share one limit. |
| `ADMIN_SIGNUP_CODE` | (none) | **Set this.** A code only Logicology's teachers are given. When it is set, the teacher sign-up form asks for it, and nobody can register without it. Logging in never needs it. Change it at any time; existing teachers are not affected. |
| `PUBLIC_URL` | (none) | The site's address, for example `https://play.logicology.in`. Needed for "Forgot password?" emails: the reset link points here. |
| `SMTP_HOST` | (none) | The email server that sends the reset emails, for example `smtp.gmail.com` or your email provider's SMTP host. "Forgot password?" sends an email only when `SMTP_HOST` and `PUBLIC_URL` are both set; otherwise it shows a message. |
| `SMTP_PORT` | `587` | Usually 587 (STARTTLS) or 465 (SSL). |
| `SMTP_SECURE` | (from the port) | `true` for SSL on connect (port 465), `false` for STARTTLS. Normally leave it out. |
| `SMTP_USER`, `SMTP_PASS` | (none) | The email account's user name and password (for Gmail/Google Workspace, an app password). Keep them secret. |
| `MAIL_FROM` | `SMTP_USER` | The sender shown on the email, for example `Prime Time <no-reply@logicology.in>`. |
| `MAIL_OUTBOX_DIR` | (none) | For testing only: write the emails as files in this folder instead of sending them. |
| `ADMIN_SECRET` | (none) | Optional. A long random string used instead of `DATA_DIR/secret.key` to sign teacher log-ins. Changing it logs every teacher out. |

Health check: `GET /health` returns `{"ok":true,"rooms":N}`.

---

## Option A: Linux VPS (Ubuntu) with PM2 and nginx

**1. Install Node.js 20**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
```

**2. Upload and unpack**
```bash
unzip prime-time-online.zip -d ~/       # creates ~/prime-time-online
cd ~/prime-time-online
npm ci --omit=dev
mkdir -p ~/prime-time-data              # teacher accounts live here, outside the app folder
```

**3. Keep it running with PM2**
```bash
sudo npm install -g pm2
PORT=3000 DATA_DIR=$HOME/prime-time-data TRUST_PROXY=1 ADMIN_SIGNUP_CODE='the-code-from-Logicology' \
  pm2 start server.js --name prime-time
pm2 save
pm2 startup        # run the command it prints, once
```

**4. nginx in front, on your domain** (for example `play.logicology.in`): `/etc/nginx/sites-available/prime-time`
```nginx
server {
    listen 80;
    server_name play.logicology.in;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # WebSockets
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;                   # keep idle game connections open
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/prime-time /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Point the domain's DNS **A record** at the server.

**5. HTTPS (free, Let's Encrypt)**
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d play.logicology.in
```

**Updating later:** check `https://your-domain/health` shows `"rooms":0` (nobody playing). Then unpack the new zip over the folder, run `npm ci --omit=dev`, and `pm2 restart prime-time`. `~/prime-time-data` is not touched.

---

## Option B: Docker

```bash
docker build -t prime-time-online .
docker volume create prime-time-data
docker run -d --name prime-time --restart unless-stopped \
  -p 3000:3000 -v prime-time-data:/app/data -e TRUST_PROXY=1 -e ADMIN_SIGNUP_CODE='the-code-from-Logicology' \
  prime-time-online
```
The image holds only the runtime files and runs as a non-root user. Teacher accounts are in the `prime-time-data` volume. Put a reverse proxy with WebSocket support and HTTPS in front, as in Option A steps 4–5. Leave out `-e TRUST_PROXY=1` if nothing sits in front of it.

---

## Option C: Managed hosting (Render, Railway, Fly.io)

- **Render:** New → Web Service from a Git repository containing this folder. Build `npm ci --omit=dev`, start `npm start`, **1 instance**. Add a **persistent disk** (for example mounted at `/var/data`) and set `DATA_DIR=/var/data` and `TRUST_PROXY=1`. Free instances sleep when idle and lose their disk, so use a paid instance for schools.
- **Railway:** `railway up` in the folder. Add a volume, and set `DATA_DIR` to its mount path and `TRUST_PROXY=1`.
- **Fly.io:** `fly launch` (it uses the Dockerfile). Create a volume mounted at `/app/data`, keep **one machine**, and set `TRUST_PROXY=1`.

On all three, also set `ADMIN_SIGNUP_CODE` as a secret environment variable.

---

## Checking it works

1. Open the site → **Me and my friends** → enter a name → **Play against the computer** → **Start game**. A computer player should take turns.
2. Open the site on a second device. Create a game there, and join it from the first device with the 5-letter code.
3. **My class** → **Teacher? Log in here** → **Sign up as admin**. The form should ask for the sign-up code, and a wrong code should be refused. Then create a game, and join it from another device with the 6-digit code and a grade. Restart the server and check that the teacher can still log in. That proves `DATA_DIR` is persistent.
4. If email is set up: on the teacher log-in screen, type the email and tap **Forgot password?**. An email with a link should arrive within a minute; the link opens a "New password" screen. (The server log shows `Reset email failed: …` if the SMTP settings are wrong.)
5. `https://your-domain/health` returns `{"ok":true,…}`.

## Good to know

- **Who can sign up as a teacher:** only people who know `ADMIN_SIGNUP_CODE`. Without that variable, anyone who opens the site can create an admin account. Logicology decides the code and gives it to schools.
- **"Forgot password?"** emails a reset link once `PUBLIC_URL` and `SMTP_HOST` are set (see the table). The link works for 60 minutes and only once; at most one email per address every 2 minutes. The form gives the same answer for unknown addresses, so it can't be used to find accounts. Without email, a lost password needs the account removed from `admins.json` (then sign up again).
- **Teacher passwords:** at least 6 characters, with at least one number (owner's rule).
- **School games** start by themselves when every seat is taken, or after 1 minute with the students who joined (the teacher can add a minute; with fewer than 2 students the teacher is asked).
- **Word filter:** rude words in chat become stars (`****`), and a rude name is refused ("Please choose a different name."). It covers English and Hindi/Hinglish (Latin letters and Devanagari) and sees through tricks like `sh1t`, `fuuuck` and `f u c k`. It matches whole words, so words like *class* or *Shital* are fine. To block more words without changing code, put them in `DATA_DIR/blocked-words.txt`, one per line (`#` starts a comment; `word*` = any word starting with it; `*word*` = any word containing it; several words = a phrase). The server reads the file again within a few seconds of a change. The built-in list is at the top of `wordfilter.js`.
- **Old games are cleaned up** after 6 hours without activity.
- **The tests need dev dependencies:** `npm install` (not `--omit=dev`). Then `npm test`, `npm run test:e2e` and `npm run test:admin`. They use ports 3100 and 3101.
