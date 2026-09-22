# Upstream provider response fixtures

These capture whether **list** responses include description text (before any
huntley handoff). Used by coverage documentation and offline adapter tests.

| Fixture | Description in list response? |
| --- | --- |
| `ashby-list.json` | Yes — `descriptionPlain` |
| `lever-list.json` | Yes — `descriptionPlain` plus structured `lists` |
| `greenhouse-list.json` | Yes — HTML `content` |
| `getro-search.json` | No — title/url/org/date only |
| `consider-jobs.json` | No — title/url/company/timestamp only |
