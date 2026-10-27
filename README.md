# Prime Time Online

An online multiplayer version of **Logicology's Prime Time**, the board game about prime numbers and prime factors. 2–6 players (people and/or computer players), in real time, in any modern browser. It is designed for iPads, works on computers too, and has a simpler layout for phones.

**To put it online, read [DEPLOY.md](DEPLOY.md).**

## Run it on your own computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to use another port)
```

## The two ways to play

The first screen asks **"Who is playing?"**

- **Me and my friends** (home use). Enter a name, then *Create a game* (share the 5-letter code or invite link), *Play against the computer*, or join a friend's game with their code. The person who creates the game is the host. They start it, add computer players and change the settings.
- **My class** (schools). A teacher signs up (with the site's sign-up code, if one is set) and logs in as an **admin**, sets up the game (number of players, grade, hints, timer, SKIP cards, games in a series) and gets a **6-digit code**. Students log in with their name, grade and the code. The game starts by itself when every seat is taken, or after 1 minute with the students who came (the teacher can add a minute). The teacher does not play. They watch the board and can pause, end or close the game and remove students who drop out. A student's grade is only recorded (for later analysis); it does not change the game.

Players can open a chat and a list of the moves from the game screen. A word filter hides rude words in chat and refuses rude names. "Forgot password?" emails teachers a reset link once email is set up (see DEPLOY.md).

There is also a classic layout at `/classic` (the first version, best on small phones).

## What's in the folder

```
server.js         Web server (Express) and live game traffic (Socket.IO): rooms, players, timers
game.js           The rules engine: deck, toss, deal, moves, scoring
accounts.js       Teacher (admin) accounts, stored in DATA_DIR/admins.json
wordfilter.js     Word filter for names and chat (more words: DATA_DIR/blocked-words.txt)
public/           Everything the browser loads:
  index.html, app.css, app.js   the main (tablet) layout
  rules.js        rules shared by the server and the browser
  classic/        the classic layout at /classic
  assets/         Logicology's artwork (board, cards, logo, stickers) and the two fonts
test/             Automated tests (need `npm install` with dev dependencies)
Dockerfile        Container image
DEPLOY.md         How to put it online
```

## Tests

```bash
npm install
npm test             # 3,000+ simulated games checking every rule
npm run test:e2e     # network test: players, a 2-game series, reconnects, computer players
npm run test:admin   # teacher accounts and password reset, a class game, the join time, pause and end, closing the game
```
