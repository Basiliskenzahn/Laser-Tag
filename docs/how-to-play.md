# How to play

A guide for players. For setup, see [Getting started](getting-started.md).

## The short version

1. Everyone opens the game and enters the **same room code**.
2. In the lobby, **scan** every player: someone holds a phone on them while they turn slowly in a circle.
3. Anyone taps **Launch**. After a short countdown, the round starts.
4. Point the crosshair at another player and tap **FIRE**.
5. Last player standing wins. Everyone returns to the lobby, and anyone can launch the next round.

## Joining

Enter a name (up to 20 characters) and a room code (up to 16 letters, digits or `-`; it's case-insensitive). Tap **Continue** and allow camera access. The first load takes a few seconds while the phone downloads the recognition models.

An iPhone will also ask for **Motion & Orientation access**. Allowing it is worth it: your phone then shares how much it's being moved, which helps the other phones confirm that the person they're aiming at really is you. Declining only makes recognition fall back to appearance alone — everything still works.

- A room holds **2 to 8 players**.
- You can't join a room while a round is running. You'll see *"Lobby is already running."* Wait for the round to finish and try again.
- Your phone remembers your name and room. If you reload the page or briefly lose connection, it rejoins you automatically as the same player.

## The lobby

The lobby lists everyone in the room with their scan status:

| Status | Meaning |
| --- | --- |
| **Not scanned** | This player still needs a scan. The round can't start yet. |
| **N scan samples ready** | Scanned and ready. |

Each player has a **Scan** (or **Rescan**) button. **Any phone can scan any player**, which is usually easiest: you hold your phone on a friend, then they scan you.

**Launch** starts the round once there are at least 2 players and everyone is scanned. If someone isn't, the lobby tells you who: *"Scan everyone before launch: Alice, Bob"*.

**Leave** removes you from the room immediately.

## Scanning a player

Scanning teaches every phone what a player looks like, so it can tell players apart during the game. It takes about 15 seconds, plus a few more for processing.

1. Tap **Scan** next to the player's name.
2. **3-second countdown.** The player steps back until their **whole body**, head to feet, is in frame, and faces the camera.
3. **12 seconds of recording.** The player **turns slowly in one full circle** on the spot. The person holding the phone keeps it steady and keeps the player centred.
4. **Processing.** The phone works through the recording and picks the best 12–24 views; the on-screen text counts the frames as it goes. You return to the lobby with *"Saved scan for Alice with 24 angles."*

The **✕** in the corner cancels at any point and returns to the lobby. A cancelled scan changes nothing, so a player who was already scanned keeps their old scan.

If the scan fails, the message tells you why:

| Message | What to do |
| --- | --- |
| *step a little closer* | The player is too small in the frame. |
| *move fully inside the frame* | Part of the body is cut off at the edge. |
| *stand straighter or show more of your body* | Only part of the body is visible, or the pose is unusual. |
| *keep your body clearer in the camera* | The detector wasn't confident there was a person. |
| *move into brighter light* | Too dark. |
| *avoid strong backlight* | Overexposed, e.g. standing in front of a window. |
| *use a less flat background or better light* | Too little contrast. |
| *turn a little slower* | Motion blur. |
| *no person detected* | Nobody found in the frame. |

Your phone also remembers your own scan for that room and name. If you leave and rejoin the same room with the same name, your old scan comes with you.

## Playing

The round starts after a 3-second countdown with beeps and a **GO!**.

- The **crosshair** is the centre of the screen. It lights up when it's on a player you can hit.
- Tap **FIRE** (or press **Space** on a laptop). You can fire roughly three times a second.
- Each person the camera sees gets an outline:

| Outline | Meaning |
| --- | --- |
| **Green, with a name** | A recognised player who is still in the game. |
| **Green, "*name* (moves)"** | Even better: their own phone's movement confirms it's really them. |
| **Red** | The recognised player currently under your crosshair. |
| **Grey, dashed, "down"** | A recognised player who has been knocked out. |
| **Grey, dashed, "Person"** | Someone the phone can't identify. Shots at them don't count. This also covers a bystander who looks like a player — if their movement doesn't match that player's phone, the game would rather say nothing than credit a wrong hit. |

Inside each outline are two smaller boxes: the **head** (dashed) and the **body**.

### Damage

| Hit | Damage | Shots to knock out from full HP |
| --- | --- | --- |
| Body | 20 | 5 |
| Head | 50 | 2 |

Everyone starts with **100 HP**. At 0 HP you're down for the rest of the round. Your HP bar at the top turns red when it's low; a ★ next to a name counts that player's round wins.

### Feedback

- **You hit someone:** a short "ping" (a double ping for a headshot), and a popup like `−20` or `HEADSHOT −50`.
- **You got hit:** a buzz sound, a red flash, and a vibration on Android. iPhones don't support vibration in the browser.
- **Round over:** a jingle for the winner, a sadder one for everyone else, and everyone returns to the lobby.

## Tips for a good game

- **Wear different clothes.** Recognition is based on how people look. A model trained to tell people apart does most of the work, so similar outfits are survivable, but two players in near-identical clothing will still sometimes show up as "Person" rather than by name. That's deliberate: a missed hit is better than crediting the wrong player.
- **Scan where you'll play.** Lighting changes how people look on camera.
- **Keep your whole body visible** to opponents. The phone needs a decent view of a person to recognise them.
- **Give it a moment.** A newly visible player needs a moment of steady recognition — around a third of a second, longer if they've only just come into frame — before they become targetable.
- **Keep moving if motion is enabled.** With `?motion=on` or `?motion=strict`, movement is a second, independent clue: when you walk or dodge, your phone's own motion tells the other phones that the person they see is you. Standing perfectly still doesn't break anything, it just leaves recognition to appearance alone.
- **Keep the screen on.** The game asks the phone to stay awake, but switching apps can pause the camera.
