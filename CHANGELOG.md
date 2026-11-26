# Changelog

## 0.7.1

- A Claude Code question card (AskUserQuestion) in a terminal now reaches the Orca bot. Orca reports it as `waiting`, and its words need no `?` ("아무거나 고르세요."), so 0.7.0 took it for an idle screen and sent nothing (measured 2026-11-26). A line that starts with the card's footer (`Enter to select`, `Esc to cancel`), under at least one numbered choice, now counts as asking; the mail carries the card's question and choices. Words that only quote the footer do not.
- A chat's words are read only after the person last spoke, so a question already answered is not sent again.
- A terminal mail waiting for a retry no longer waits behind another bot's refused one, and is dropped when `orcaBots` no longer names that bot for its workspace. When `orca bot list` cannot be read (the default bot), it is kept, not dropped.

## 0.7.0

- grokbot-notify hands what needs a person to an Orca bot as local mail (`orca orchestration send --to bot:<name> --type question`): blocked terminals and chats, a `done` or `waiting` whose last words ask something, and FullOps decisions, ask/blocked judgments, holds, failures and escalations. New setting `orcaBots`; empty means the only bot in `orca bot list`.
- Project alerts (agent states, FullOps events, question cards) no longer go to Grok Bot routines unless the new setting `grokProjectAlerts` is on. Orca bots' Needs you items still go. For 0.6.0's behavior exactly, turn `grokProjectAlerts` on and set `orcaBots` to `off`.
- With `grokProjectAlerts` off, a card the orca-helm-ask hook holds is let go at once, so Claude Code shows it without waiting.
- docs/orca-bots.md describes the three paths (Grok and Orca bots over KnowsLink, Grok to projects with the orca-helm CLI, project alerts to Orca bots) and the KnowsLink design.
