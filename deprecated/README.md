# Deprecated

Code moved out of the working codebase, kept for reference rather than deleted outright. None of
this is built, run, tested, or deployed - it is not imported by anything under `public/`,
`backend/`, `frontend/`, or `docker-compose.yml`.

## `server/`

The original Node.js backend (`index.js` combined dev server, `realtime.js` protocol/room
bookkeeping, `game.js` pure game rules) plus its test suite. It reimplemented the same game rules
and wire protocol as `backend/` (Python, actually deployed) so that `npm start`/`npm run dev`
could run the whole game without Docker or Python. See
[`docs/streamlining.md`](../docs/streamlining.md) for the history of why keeping two backend
implementations in sync was flagged as a problem before this move.

**Consequence of removing it, worth knowing:** `backend/` (the live Python implementation) has no
automated tests of its own - `server/game.test.js` and `server/realtime.test.js` were the *only*
automated coverage of this game's rules and wire protocol that existed anywhere in the repo, and
they tested the Node copy, not the Python one. Moving `server/` out removes that coverage
entirely; nothing currently verifies `backend/models.py`/`backend/transport.py` automatically.
Porting the scenarios in those two test files to pytest (or Node's `node:test` run directly
against the Python process over HTTP, no port needed) would restore that safety net. See
[`docs/streamlining.md`](../docs/streamlining.md) for this listed as the top open item.

## `public-dead-code.js`

Frontend functions that were still present in `public/` but provably unreachable - no button, no
caller, nothing wires them up. Left over from an earlier manual single-capture scan UI that was
replaced by the automatic "stand and rotate" flow. See the file's own header for exactly what each
piece used to do.
