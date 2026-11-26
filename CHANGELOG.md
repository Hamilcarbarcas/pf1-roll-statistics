# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## Unreleased

### Added
- Records every roll on the GM's client: dice, natural d20, total, roller and character, item and target defenses. Stored per day in the module's storage folder.
- Rolls made on PF1 Roll Requests cards are recorded, including repicks and amended results.
- Rolls made while no GM was connected are recovered from the chat log at the next GM login.
- Deleting a card from today's session removes its rolls; clearing chat or bulk deletes don't.
- **Day starts at (hour)** setting, default 4 am.
- **Roll Statistics window**, opened from the Journal Notes scene controls: Dice Averages (Users and Actors), Fortune, Attacks and Checks, for a session, the last N sessions, or lifetime.
- **Sharing:** the GM can show any report to chosen players, and set which reports players can open themselves.
- Report data from the console: `game.pf1RollStatistics.report(id, params)`.
