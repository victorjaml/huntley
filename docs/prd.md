# huntley — Product Requirements

This document is the source of truth for what huntley must do. It describes intended behaviour in product terms and says nothing about how the behaviour is achieved — mechanisms, contracts and limitations live in [tech-design.md](tech-design.md), and the procedures for running it live in [README.md](../README.md). Where the shipped system disagrees with this document, this document is right and the system has a bug.

---

## 1. The problem

You're looking for a new job. Good roles are discoverable, but only if you go and look — and looking means refreshing LinkedIn, Indeed, Glassdoor, etc, by hand every day, indefinitely. The cost is not any single check; it is that the checking never ends and its value is invisible until the one day it isn't.

Two things make manual checking worse than it sounds:

- **Some roles are not on the boards.** Many companies post to their own ATS — Greenhouse, Ashby, Lever, Gem, JazzHR, BambooHR, Breezy, Jobvite — days before a consumer board picks it up, and sometimes never. Checking the boards alone means seeing a filtered, delayed subset.
- **Volume is not the bottleneck; relevance is.** A search that returns two hundred roles has not helped. What helps is a short list you can trust, where each row already answers "why am I looking at this?"

## 2. Who it is for

One person: the operator, who is also the only user. `huntley` is a personal tool.

A secondary constraint follows from publishing the code: **anyone must be able to clone the repository and run it on their own machine**, with their own identity, targets and credentials, without inheriting a trace of the original operator's data.

## 3. Product principles

These are the commitments the rest of the document elaborates. They are ranked: where two conflict, the higher one wins.

**P1 — The operator applies. huntley never does.**
huntley discovers, ranks and reports. It doesn't submit an application or send a message to an employer.

**P2 — Silence means failure, never "nothing today".**
The product surface is a daily email. If that email does not arrive, the only conclusion the operator should ever draw is that the job did not run. A day with no matches must still produce an e-mail.

**P3 — Every claim is auditable.**
A score without a reason is not output. A recommendation without its evidence is not a recommendation. The operator must always be able to ask "why is this here?" and "what did you hide from me?" and get an answer in the product.

**P4 — Nothing that shapes future results changes without consent.**
huntley may propose changes to what it looks for. It may not make them. The operator's stated preferences change by the operator's hand or by an explicit approval, and never as a side effect of a run.

**P5 — Degrade, don't disappear.**
Any single source, model, or credential may fail. A partial result delivered with its gaps declared is correct behaviour. A missing result is not.

## 4. Requirements

Requirements are numbered for reference and phrased so that each is testable. **MUST** is binding; **SHOULD** is a strong default that may be overridden by configuration; **MAY** is optional.

### 4.1 Discovery

**D1.** huntley MUST scan two distinct layers on every run:
  - **the ATS layer** — job postings published directly by employers through their applicant tracking systems, covering at minimum Greenhouse, Ashby, Lever, Gem, JazzHR, BambooHR, Breezy and Jobvite;
  - **the board layer** — consumer job boards and aggregators.

  *Status: met in part. Greenhouse, Ashby, Lever and BambooHR are covered across every company that uses them. Gem, JazzHR, Breezy and Jobvite are covered only for companies huntley has already found — through the watchlist, a fund portfolio, or an aggregator that carried one of their roles.*

**D2.** huntley MUST surface new roles on the day they are posted, where the source makes a posting date available.

  *Status: met in part. Companies huntley reads directly are same-day; roles that reach it only through a daily third-party dataset can arrive a day late.*

**D3.** Where a source does not publish a posting date, huntley MUST still surface the role rather than discard it, and MUST NOT present an unknown date as a known one.

**D4.** huntley SHOULD seed its ATS-layer coverage from startup-ecosystem sources (at minimum Y Combinator), so that early-stage companies the operator has not heard of are reachable without being named individually.

**D5.** Discovery MUST be resilient to individual source failure. If one source errors, times out or changes shape, the run continues with the remaining sources and the failure is reported to the operator (see **T2**).

**D5a.** When huntley relies on a third-party collection of postings in place of reading the underlying sources itself, it MUST detect when that collection is stale or unavailable, report it in the digest, and fall back to reading the most important of those sources directly.

**D6.** huntley MUST NOT require the operator to authenticate to any job board or ATS.

**D7.** Location MUST be expressed as the places the operator accepts, and nothing else. A role MUST appear only if its location names one of those places, or it is remote and remote roles are accepted. The operator MUST NOT have to list the places they do not want: recognising that a posting in Toronto, Bengaluru or "Remote, UK" is outside the accepted places is huntley's job. An empty list MUST mean anywhere in the United States.

**D8.** An accepted place MUST be matchable at the level the operator means: a whole state ("California"), a city in a state ("Seattle, WA"), or a city ("NYC"). A city name MUST stand for the whole city — "NYC" covers every borough and the neighbourhoods boards name as if they were cities.

**D9.** Location reading MUST NOT be fooled by names that mean something else in context. "Portland, ME" is not Portland, Oregon. "Rochester, New York" is not New York City. "CA" after a Canadian city or province is Canada, not California. A state abbreviation MUST NOT match inside another word ("CA" in "Canada"). A bare city MUST be placed in its state ("Cupertino" is in California). A placeholder location ("N/A", "TBD") MUST be treated as not stated.

**D10.** A posting that names several places MUST be judged on the best of them: a role in "London & San Francisco" or "Boston, MA, USA, New York, NY, USA" is available in a place the operator accepts.

**D11.** The operator MUST be able to choose how remote roles are treated: excluded, accepted, or accepted but ranked below an otherwise equal role with an office in an accepted place. A posting that offers an accepted office or remote counts as an office role. Remote MUST mean remote in the United States: "Remote, UK" is not accepted. A location that is only a country with no city ("United States") counts as remote; a city or state followed by a country does not.

### 4.2 The watchlist

**W1.** The operator MUST be able to keep a list of companies they already care about.

**W2.** Every company on the watchlist MUST be checked on every run, through that company's own careers page or job board — not through a board's copy of it. A posting must reach the operator even if it never appears on any job board.

**W3.** Watchlist companies MUST NOT be exempt from any rule. Their roles pass the same title, location and company rules as every other role. The watchlist changes how often a company is checked and how its matching roles rank — never whether an irrelevant role is shown. A chemical engineering role at a company the operator likes is still not a role they want.

**W4.** Matching roles from watchlist companies MUST earn a fixed, configurable number of points on top of their relevance score, and MUST be ordered with every other match by the resulting score. There MUST NOT be a separate watchlist section. The bonus MUST be visible on the row.

**W5.** The model's judgment of fit MUST NOT account for the watchlist; the bonus is added afterwards, in code. A poorly-fitting role at a favoured company must still be described as a poor fit, and the model's own score MUST be kept in the run record.

**W6.** The operator MUST be able to add VC portfolio job boards — a fund's job board across its whole portfolio — as a discovery source. They MUST be checked on every run like watchlist companies, but their roles MUST NOT earn the watchlist bonus: a portfolio board is a way to find companies, not a company the operator already cares about.

**W6a.** The operator MUST be able to add a VC fund that has no portfolio job board, by naming the fund's public portfolio page. huntley MUST find each portfolio company's own job board and check it on every run, with the same no-bonus rule as **W6**. A fund whose page cannot be read MUST be reported in the digest, not silently dropped, and a company whose board cannot be found MUST NOT be guessed onto another company's board.

**W7.** huntley SHOULD provide a way to resolve a company name to its actual job board, so that maintaining the watchlist does not require the operator to research each employer's recruiting vendor by hand.

### 4.3 Deduplication and ranking

**R1.** The same role reaching huntley through more than one source MUST appear to the operator exactly once.

**R2.** When copies of one role are merged, the surviving entry MUST link to the employer's own posting in preference to a board's copy of it, and MUST retain the union of what each copy knew (for example, a posting date present on one copy and absent on the other).

**R3.** A role the operator has already been shown MUST NOT be shown again.

**R4.** Every role reaching the operator MUST carry a relevance assessment made against the operator's stated background, target titles, seniority and location constraints.

**R5.** Every role reaching the operator MUST carry a short written explanation of why it fits — specific to this role and this operator. Generic praise ("a great opportunity") does not satisfy this requirement.

**R6.** A role that cannot be explained MUST NOT be presented as though it had been assessed. It may still be shown, but it MUST be visibly marked as unassessed.

**R7.** Roles that fall below the operator's relevance threshold MUST NOT appear in the digest, and the count of such roles MUST be reported (see **T3**).

**R8.** A relevance decision MUST be stable. A role assessed once and found below the threshold must not reappear later purely because the assessment was re-run.

**R9.** huntley MUST NOT fabricate detail a posting does not contain — compensation, remote policy, team, or level.

**R10.** Title relevance MUST work in two steps. First, a title MUST name a kind of role the operator does — a role word such as "engineer", "scientist", "researcher" or "technical staff" — to be considered at all. Second, each of the operator's focus keywords appearing in the title MUST make the role more relevant: a title matching more keywords is more specific, and ranks ahead of one matching fewer. The operator MUST NOT be required to list whole job titles; titles in the market are too varied for an exact title to ever match.

**R11.** The operator MUST be able to exclude compound titles that contain a role word but mean a different job — "mechanical engineer", "rocket scientist". An exclusion MUST override both role words and keywords, and MUST apply to every source.

**R11a.** The operator MUST be able to carve a condition out of a specific exclusion — exclude "software engineer" unless the title also says "staff". The condition MUST match wherever it appears in the title and MUST cancel only the exclusion it belongs to.

**R11b.** A malformed title configuration MUST fail loudly rather than load with filters silently disabled.

**R12.** Keyword matching MUST be on whole words: a short keyword MUST NOT match inside an unrelated word ("ml" inside "HTML", "intern" inside "Internal"). One idea MUST count once: a keyword repeated in a title, or keywords that overlap in the operator's list ("ai safety" and "safety"), MUST NOT inflate relevance.

**R13.** No stage that runs before huntley's own filtering MAY reject a title that huntley's rules would keep. An earlier stage may only be broader.

### 4.4 The daily digest

**E1.** huntley MUST send exactly one email per day containing that day's matches, and MUST also be runnable on demand.

**E2.** Each row MUST show: company, title, location, why it fits, and a link to the posting.

**E3.** Matches MUST be ordered by score alone, highest first, with the watchlist bonus (**W4**) included in that score.

**E3a.** No company MAY take more than a configurable number of rows in one digest; the same limit applies to watchlist companies. A row from a company with further matching roles MUST say how many, so the operator knows its job site is worth visiting. Roles held back this way MUST be treated as already shown, so the same company is not offered again one role a day.

**E4.** A day with zero matches MUST still send an email. That email MUST make clear that the run happened and found nothing, rather than looking like an error or an empty template. *(P2)*

**E5.** The digest MUST report what it filtered out: how many roles were dropped, and representative examples with the reason each was dropped. *(P3)*

**E6.** The digest MUST be legible on a phone and MUST NOT depend on loading remote resources to be readable.

**E7.** Email MUST be outbound-only. huntley MUST NOT require access to the operator's mailbox for any feature.

### 4.5 Add — moving a role to the tracker

**A1.** Every digest row MUST carry an **Add** control.

**A2.** Add MUST mean *"I want to apply to this"*. It MUST NOT mean, record, or imply that an application was submitted. The resulting tracker entry MUST be distinguishable at a glance from one the operator has actually applied to. *(P1)*

**A3.** Add MUST work from the email itself, on any device, without the operator returning to a terminal and without huntley having access to the mailbox.

**A4.** Add MUST place the role on an application tracker stored in a Google Sheet, which the operator can read and edit directly.

**A5.** Adding the same role twice MUST NOT create two tracker entries.

**A6.** The Add mechanism MUST NOT require exposing the operator's machine or home network to inbound connections from the internet.

**A7.** An Add control MUST NOT be actionable by someone who merely obtains a copy of the email at an arbitrary later date.

**A8.** There MUST be exactly one tracker and one shortlist. Roles the operator wants, has applied to, and has heard back about live in one place.

### 4.6 The weekly preference review

**M1.** huntley MUST maintain a durable preference memory: the target roles, filters, watchlist and free-text notes that shape ranking. It MUST be human-readable and directly editable by the operator at any time.

**M2.** Weekly, and on demand, huntley MUST review:
  - the tracker;
  - what the operator added versus what they were shown and did not add;
  - how applications progressed.

**M3.** From that review huntley MUST produce a set of *proposed* changes to the preference memory, and MUST email them to the operator as a readable diff.

**M4.** huntley MUST NOT apply a proposed change as part of producing it. The preference memory changes only when the operator clicks an APPROVE control, and the change takes effect on a subsequent run. *(P4)*

**M5.** Every proposed change MUST be presented together with the specific evidence that produced it — the actual roles involved — in the email itself, not behind a link. *(P3)*

**M6.** When there is too little data to support a finding, huntley MUST propose nothing and MUST say so. It MUST NOT infer a pattern from a handful of data points.

**M7.** A review that finds nothing worth changing MUST still notify the operator. *(P2)*

**M8.** The operator MUST be able to tell, at any time, which parts of their preference memory changed by their own hand and which changed by approval.

**M9.** Applying an approved change MUST be reversible.

### 4.7 Operation and trust

**T1.** huntley MUST run unattended on a schedule on the operator's own always-on machine, and MUST also run on demand from the operator's laptop against the same configuration.

**T2.** When any part of a run degrades — a source fails, a credential is missing, an input cannot be read — the resulting digest MUST declare it prominently. The operator must never receive a thin digest that looks normal. *(P5)*

**T3.** Every digest MUST report the run's arithmetic: how many postings were fetched, merged, filtered, scored below threshold, and shown. The operator must be able to tell a quiet day from a broken scan.

**T4.** huntley MUST provide a way to verify an installation — configuration, credentials, dependencies and scheduling prerequisites — before the operator relies on it.

**T5.** A failed send MUST NOT cause the roles in the undelivered digest to be treated as already shown.

### 4.8 Source conduct

**S1.** When a source signals rate limiting, huntley MUST back off from that source for the remainder of the run rather than continuing.

### 4.9 Privacy and portability

**V1.** All personal data — identity, targets, watchlist, credentials, tracker contents, run history — MUST be excluded from version control.

**V2.** A clone of the repository MUST contain no trace of any previous operator's search.

**V3.** A new operator MUST be able to go from clone to a working digest using only the repository's own instructions and their own accounts.

**V4.** Personal data MUST be excluded from commits by default, so that staging everything cannot include it.

**V5.** Credentials MUST be supplied through the environment, never written into configuration files that a operator might share when asking for help.

**V6.** huntley's own test suite MUST NOT be able to write to the operator's real state or configuration. A test that needs a fixture MUST be able to redirect both to a scratch location, and MUST verify the redirection took effect before writing.

---

## 5. Glossary

| Term | Meaning |
|---|---|
| **ATS layer** | Postings read from employers' own applicant tracking systems. |
| **Board layer** | Postings read from consumer job boards and aggregators. |
| **Watchlist** | Companies the operator cares about: checked on every run, matching roles earn a score bonus. |
| **Portfolio board** | A VC fund's job board across its portfolio: checked on every run, a discovery source. |
| **Fund portfolio** | A VC fund without a portfolio board, listed by its public portfolio page; its companies' own job boards are found and checked on every run. |
| **Digest** | The single daily email. |
| **Add** | The control that records intent to apply. Never a submission. |
| **Tracker** | The Google Sheet holding roles the operator intends to apply to, has applied to, and has heard back from. |
| **Preference memory** | The durable, editable statement of what huntley looks for. |
| **Proposal** | A set of changes to preference memory, emailed for approval, never self-applied. |
| **Degraded run** | A run where some part failed and the digest says so. |
