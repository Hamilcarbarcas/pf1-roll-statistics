# PF1 Roll Statistics

Tracks dice rolls for Pathfinder 1e and reports them per session and over the long term.

**Manifest URL:** `https://github.com/Hamilcarbarcas/pf1-roll-statistics/releases/latest/download/module.json`

## Requirements
- Foundry VTT v13
- PF1e system v11.11

## Contents

- [Overview](#overview)
- [What gets recorded](#what-gets-recorded)
- [Sessions](#sessions)
- [Reports](#reports)
  - [Opening the reports](#opening-the-reports)
  - [Dice Averages](#dice-averages)
  - [Fortune](#fortune)
  - [Attacks](#attacks)
  - [Checks](#checks)
  - [Sharing and visibility](#sharing-and-visibility)
- [Settings](#settings)

## Overview

Records every roll made in the game: the dice, the natural d20, the total, who rolled it and as
which character. Reports show averages, luck and success rates for a session, the last few
sessions, or the whole campaign.

## What gets recorded

- Attacks, crit confirmations, damage and healing, with the item that made them.
- Skill checks, saves, ability checks, initiative, caster level and concentration checks.
- Plain dice rolls from chat and macros.
- Rolls made on [PF1 Roll Requests](https://github.com/Hamilcarbarcas/pf1-roll-requests) cards.

The GM's client does the recording, so a GM needs to be logged in. Rolls made while no GM is
connected are picked up from the chat log the next time one logs in.

Deleting a roll's chat card removes it from the statistics, if it's from today's session.
Clearing the chat log or deleting many cards at once doesn't, so cleaning up chat keeps your
history.

## Sessions

Each day is a session. The day starts at 4 am by default, so a game that runs past midnight stays
one session.

## Reports

### Opening the reports

Click the chart button in the **Journal Notes** scene controls. Pick a report on the left, and a
session, the last few sessions, or lifetime at the top.

Averages show how many rolls they cover in brackets. A value turns green or red only when it's
further from average than chance alone would usually put it, so a handful of rolls stays neutral.
Hover over a number for the expected value.

**Include recovered rolls** covers rolls picked up from the chat log after the fact. Their target
AC was read when they were recovered, so hit rates for them are approximate.

### Dice Averages

The average roll on each die size. **Users** has one row per player, with the GM below. **Actors**
has one row per character or creature. Click a number to see how often each face came up.

### Fortune

Who was lucky and who wasn't:

- **d20 luck** ranks players by their average d20.
- **All-dice luck** ranks players by how high they rolled on every die. Each die counts the same,
  so a 6 on a d6 is as lucky as a 20 on a d20.
- **Natural 20s and 1s** counts each player's natural 20s and 1s. Only the die that was kept
  counts; the dropped die of a roll-twice doesn't.

The GM is listed separately and isn't ranked against the players.

### Attacks

One character's attacks, grouped by weapon or ability: average d20 and total, hit rate, threats
and confirmation rate, and average damage. Crit damage can be shown separately or added into the
damage. Healing abilities show average healing.

Hit and confirm rates count only attacks made against exactly one target, compared with that
target's AC (CMD for combat maneuvers).

### Checks

One character's saves, skills, ability checks, initiative and spellcasting checks: average d20,
average total, and the success rate where the DC was known.

### Sharing and visibility

Dice Averages (Users) and Fortune are open to everyone. The GM decides about the rest:

- **Share** shows the report you're looking at to the players you pick, in a window of its own.
- **Visible to** lets players open a report themselves: **Everyone**, **GM only**, or **Owners**
  (players see it only for characters they own).

## Settings

- **Day starts at (hour):** the hour a new day's session begins.
