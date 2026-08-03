# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML/CSS/JS, no framework and no build step. `data/status.js` is loaded as a
plain script rather than fetched so the dashboard works when opened directly from `file://`.
Python scripts (`auto_update.py`, `scrape_collectors.py`, `scrape_media.py`) rewrite the data
file out of band.

## Users

Primary: students and parents in Kerala, on a phone, typically late evening (around 10pm),
asking exactly one question — "is my district off tomorrow?" They want the answer without
scrolling, reading, or interpreting. Secondary: people scanning all 14 districts and the
advisories around them.

## Product Purpose

Show verified rain-holiday declarations for all 14 Kerala districts for a target date, so a
household can decide about tomorrow morning tonight. Success is a correct answer, understood
in seconds, that the reader trusts enough to act on.

## Positioning

Every `confirmed` district carries at least one dated source and a declaring authority.
Nothing on the page is inferred by the app: the distinction between a declared holiday, an
unconfirmed rumour, a partial/taluk-level closure, and an actively debunked claim is the
product. Social-media rumour aggregators cannot truthfully make that claim.

## Operating Context

District Collectors declare closures individually, often late at night, sometimes only for
specific taluks or only for relief-camp schools, sometimes with exams explicitly excluded.
Declarations arrive after the reader has already started asking. The page is checked
repeatedly through an evening, and a stale page is dangerous, so the data carries
`checkedAt` and the app guards against showing a date that has already passed.

## Capabilities and Constraints

- `data/status.js` schema is frozen: `forDate`, `forDateLabel`, `checkedAt`, `headline`,
  `advisories[]`, `weather{}`, `districts[]` (`name`, `status`, `alert`, `confidence`,
  `scope`, `appliesTo`, `excludes`, `reason`, `declaredBy`, `exams`, `confidenceNote`,
  `sources[]`), `debunked[]`, `limitations[]`.
- District `status` is one of `confirmed`, `unconfirmed`, `none`, `false`.
- `alert` is one of `red`, `orange`, `yellow`, `none` (IMD colour warnings).
- Partial closures are not a status; they are derived from `scope`/`appliesTo` mentioning
  relief camps or taluks.
- No server, no build, no network at render time. Must keep working from `file://`.
- Data is only as fresh as the last agent run; the UI must never imply live certainty it
  does not have.

## Brand Commitments

Name: Kerala Rain Holiday Watch. The hero heading is Malayalam — "അവധിയുണ്ടോ?" ("is there a
holiday?"). Malayalam is scoped to the heading and brand; district names, status labels, and
source/authority text stay English so wording stays verifiable against official
announcements. Independent platform, not affiliated with any government entity — this
disclaimer must remain visible.

## Evidence on Hand

Real scraped declarations with named authorities (District Collectors) and source URLs
(Onmanorama and similar) in `data/status.js`. Real IMD alert levels. `kerala_hero.png` is an
existing hero image. There are no testimonials, user counts, install numbers, or
accuracy/uptime statistics — none may be fabricated.

## Product Principles

1. The answer before the evidence: the district verdict comes first, the sourcing supports it.
2. Never flatten certainty levels — confirmed, partial, unconfirmed, and debunked must stay
   visually distinct at a glance.
3. Freshness is part of the answer; an old page must say so loudly.
4. Phone at night is the design target, not a narrower desktop case.
5. Absence of a declaration is information, not an empty state.

## Accessibility & Inclusion

Read one-handed on a phone in poor light. Status must never be carried by colour alone.
Malayalam and Latin text must both render with correct glyphs and comfortable line height.
