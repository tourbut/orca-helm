# Changelog

## 0.7.0

- grokbot-notify hands what needs a person to an Orca bot as local mail (`orca orchestration send --to bot:<name> --type question`): blocked terminals and chats, a `done` or `waiting` whose last words ask something, and FullOps decisions, ask/blocked judgments, holds, failures and escalations. New setting `orcaBots`; empty means the only bot in `orca bot list`.
- Project alerts (agent states, FullOps events, question cards) no longer go to Grok Bot routines unless the new setting `grokProjectAlerts` is on. Orca bots' Needs you items still go. For 0.6.0's behavior exactly, turn `grokProjectAlerts` on and set `orcaBots` to `off`.
- With `grokProjectAlerts` off, a card the orca-helm-ask hook holds is let go at once, so Claude Code shows it without waiting.
- docs/orca-bots.md describes the three paths (Grok and Orca bots over KnowsLink, Grok to projects with the orca-helm CLI, project alerts to Orca bots) and the KnowsLink design.
