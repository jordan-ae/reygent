# Reygent

Autonomous job-search operator for a software engineer based in Cameroon (UTC+1),
working as an independent B2B contractor. It finds remote roles, works out which ones can
engage a Cameroon-based contractor, writes a tailored application from facts you have
verified, and submits it — until 2–3 concurrent engagements reach the monthly income goal
you set.

TypeScript throughout: a Next.js console for setup and oversight, and a command-line
pipeline that does the work. The design is in
[docs/reygent_system_design.md](docs/reygent_system_design.md).

## Going live

Requires Node 24 or newer and Google Chrome (the pipeline drives your installed Chrome; no
browser is downloaded).

```bash
npm install
```

One command wakes everything up:

```bash
npm run wake
```

It starts the console at http://127.0.0.1:8765, tells you what is still missing and waits
while you fill it in, runs a pre-flight (one tiny real call of each kind to both model
APIs, well under a hundredth of a cent, so a wrong key shows up there and not in the middle
of a cycle), and then starts the pipeline: a cycle every hour, re-reading your settings
before each one. Ctrl+C stops it. Start it once and leave it running.

Three things are yours to supply, because Reygent never invents them:

1. **Profile** — name, email, phone, links, notice period, your work history and your own
   CV as a PDF (each application attaches your CV [tuned to its listing](#your-cv-tuned-to-each-listing);
   only with no work history does the PDF go out as it is, and with neither a one-page
   resume is generated from the fact bank), and *screening notes*: the facts an application form asks
   about, in your own words (citizenship, where you are and are not authorized to work,
   that you invoice as a contractor and need no sponsorship).
2. **Fact bank** — your real achievements, each marked verified once every detail is
   accurate. Every metric, technology and employer Reygent writes must trace back to one.
3. **Settings → API keys** — TypeSafe (Jev) and Fireworks. Stored in
   `~/.reygent/secrets.json`, readable only by you, never sent back to the browser.

For the first run, watch it work. `--watch` fills each form in a visible Chrome window and
leaves Submit to you, whatever the settings say:

```bash
npm run wake -- --watch
```

When the forms it fills look right, stop it and start it again without `--watch`.

## What a cycle does

| Step | What happens | Cost |
| --- | --- | --- |
| Discover | Reads company job boards, remote-job sites and the Hacker News hiring threads (each no more often than its terms ask); sorts each new listing into an eligibility tier | free |
| Investigate | For listings that say "Remote" without saying where: can a Cameroon-based contractor be engaged? | Jev |
| Score | Fit against your skills and verified work; listings under the threshold are dropped | Jev |
| Draft | Opens the application form to read its questions, then tunes and rewords your CV for the listing and writes the pitch and answers. The Cop Tool checks all of it | Fireworks, Jev |
| Apply | Fills the form in Chrome and submits it; keeps a screenshot of the filled form and of the confirmation page | free |

Effort is split across channels (founder direct, ATS inbound, recruiter direct, contract
gigs) by a UCB1 allocator that learns from the outcomes you record.

## Your CV, tuned to each listing

An applicant tracking system ranks a CV by the listing's own words, read from the PDF's
text layer. So with your work history filled in (**Profile → Work history**), every
application carries your whole CV rebuilt around its listing:

- **The listing is read for what it asks for** — its skill list, every skill of yours it
  names under any spelling, and (with a Fireworks key) the tools and methods the writing
  model finds in it. A term is kept only if the listing really contains it.
- **Each term is settled against your CV.** It is *backed* when it is a skill you list
  (`Postgres` is your `PostgreSQL`) or when a line of your CV already says it (`payment
  systems` is your "payment infrastructure"). Everything else is *missing*.
- **Backed terms go on the page in the listing's spelling**: `PostgreSQL (Postgres)`,
  `Go (Golang)`, asked-for skills first. The headline becomes the role applied for when
  every word of that title is something your CV says, at a level you have held; each
  role's lines are put in order of how much of the listing they speak to.
- **The summary is rewritten for the listing.** It opens with the role, names the
  expertise the listing asks for that your CV backs, and gives one piece of your verified
  work as proof. When a rewrite cannot be verified, your own summary is printed as written.
- **Your lines take on the listing's vocabulary.** An opening verb gives way to the
  listing's verb for the same act ("Engineered" becomes "Built" for a listing that says
  "build"). Where a line already names something the listing calls by another name, the
  listing's words are put in place of the line's own ("payment infrastructure" becomes
  "payment systems") and nothing else on the line moves.
- **Every rewording is checked twice before it is printed.** It must pass the Cop Tool's
  grounding and tone rules with every figure intact, and then the decision model has to
  find, with the confidence an AI answer needs, that it says nothing your verified text
  does not. A swap that would add a claim ("services" into "microservices", a tool you do
  not list, "built" into "led") is dropped and the line is printed as verified. Lines you
  wrote out yourself under a role are never reworded. Without both model keys nothing a
  model wrote is used.
- **Missing terms stay off the page, always.** They are shown on the application instead.
  If one is true of you, add it to your skills or to a verified achievement and it is
  printed from then on. This list is the fastest way to raise your match: it is where a
  skill you have but never wrote down shows up.
- **The printed PDF is read back the way a parser reads it** before it is attached: a text
  layer, your name first, contact details and links as text, the standard headings
  (Summary, Skills, Experience, Projects, Education) on their own lines and in order, each
  role with its title, employer and dates, and every backed term present. The page is one
  column with no tables, images or ligatures, and no word broken at a hyphen.
- **A CV that fails a check is repaired, never swapped.** Odd characters are put as plain
  ones, any term that did not read back is set on the skills line in its own right, and
  the CV is printed and read again. If it still does not read back whole, the application
  is held in **Quarantine** with the reason. Your original CV file is not sent in its
  place: with tuning on, that file is not used at all.

To see it for one listing without applying to anything:

```bash
npm run reygent -- tune <listing>
```

`<listing>` is a tracked listing's id (the last part of its address in the console) or a
text file holding a job description (`--title` and `--company` name it; the first line is
taken as the title otherwise). It writes the CV to `~/.reygent/resumes/tuned/<listing>/`
(`--out <folder>` to choose), and prints what the listing asks for, what is on the page,
what is missing, the rewritten summary and each reworded line beside its original, and the
read-back checks. `--no-model` keeps it free: only the listing's skill list and your own
skills are looked for, and nothing is reworded beyond opening verbs.

`pipeline.tune_cv: false` (or **Profile → Tune my CV to each listing**) sends your CV file
as it is.

## Where the jobs come from

Public feeds only; no account, login or API key is involved, and nothing behind bot
protection is read. The list is yours to edit in **Settings → Sources**:

- **Company job boards**, read through each provider's public feed by the name in the
  company's careers URL: Greenhouse (`boards.greenhouse.io/<name>`), Ashby
  (`jobs.ashbyhq.com/<name>`), Lever (`jobs.lever.co/<name>`), Workable
  (`apply.workable.com/<name>`), Recruitee (`<name>.recruitee.com`), Teamtailor
  (`<name>.teamtailor.com`) and Breezy (`<name>.breezy.hr`). The defaults are remote-first
  employers, each checked to resolve and to have matching listings.
- **Remote-job sites** with a public API or RSS feed: Remotive, Remote OK, Jobicy,
  Himalayas (its worldwide roles), Working Nomads, We Work Remotely, Real Work From
  Anywhere, Golangprojects and the Python.org job board. Their listings are tracked under
  the site's own link, as each site's terms ask, and that link is where the application
  starts.
- **Hacker News**: the monthly "Who is hiring?" thread (founder-direct: Reygent writes the
  pitch, you send it) and the "Freelancer? Seeking freelancer?" thread (contract gigs,
  also sent by you).

**Boards it finds by itself.** When a listing links to its employer's own board on one of
the seven providers (hiring threads do this a lot), that board is remembered and read from
then on, twenty per cycle in turn. A found board that shows no listing matching your
keywords in three reads is dropped. Boards are also found by name: each cycle Reygent
takes up to 25 companies it has only seen on job sites or in hiring threads, asks the
five providers whose forms it reads for a board under that company's name, and keeps a
board only if it lists one of the roles the company advertised. Most of the volume comes
from there: a company advertising one remote role on a job site usually has more on its
own board, each with a form Reygent can fill. `follow_board_links: false` turns all of
this off.

**How often.** Every source has a minimum time between two reads, taken from its own
terms and kept whatever the cycle length: a company board hourly, most job sites every
six hours (Remotive asks for at most four reads a day), We Work Remotely every three,
Himalayas once a day. A source that is not due is skipped.

**One listing per role.** The same opening often arrives from the company's board and
from several job sites. It is tracked once. The company's own listing wins, because its
link is the real application form; a job site's copy that nobody has acted on is replaced
when the company's listing turns up later.

**Applied for, or a lead.** Reygent fills and submits forms on Greenhouse, Ashby, Lever,
Workable and Recruitee. A listing from a remote-job site links to that site's own page,
usually behind a bot check, with the real application on the employer's site beyond it;
Teamtailor's and Breezy's forms are not read yet. Those listings are *leads*: Reygent
writes the pitch, keeps a copy of your CV for it, and lists it under **Pitches to send**
with the link. Mark it sent when you have applied. A lead left unsent for two weeks stops
holding its company back from other roles.

**A lead that has a form after all.** Before a pitch is written for a job site's listing,
and for every pitch still waiting to be sent, Reygent asks the five providers whose forms
it reads whether the employer has a board there under its own name, and whether the same
role is on it: the same title, and text that says the same thing. If so, the employer's
listing takes the job site's place. It is judged from the start like any new listing,
because the employer's own word on where the role can be done often differs from the job
site's "Anywhere in the World", and if it qualifies Reygent applies through the form. The
job site's copy is closed and its unsent pitch withdrawn. Each listing is looked up once;
`follow_board_links: false` turns this off too.

Only listings whose title contains one of the configured keywords are kept. LinkedIn,
Indeed, Glassdoor, Wellfound, X and Discord are not read.

## Hands-free, and where it stops

By default nothing waits for your approval: a draft that passes the Cop Tool is submitted.
Hands-free, the decision model is the only judgement in the loop, so it is required:
without the TypeSafe key, or once the daily cap is reached, nothing past discovery runs.
The free keyword scores exist to sort a list a person reads, never to send applications on.

Hands-free, nothing is handed to you. Each case below sets that one application aside,
where you can see it and why, and the next best role at the same company is tried in a
later cycle; a set-aside application is tried again by itself whenever your profile,
screening notes, fact bank or one of your answers changes. Only an application whose
Submit was pressed without a confirmation keeps its company, since it may have gone
through. No pitch is written that only you could send. With `auto_submit: false` or
`require_human_review: true` you are in the loop, and these cases wait for you instead:

**By email.** Once your mailbox's app password is stored (Settings, "Email app password";
for Gmail, create one at myaccount.google.com/apppasswords), hands-free runs also send
applications by email from your own address, where the employer takes them that way: a
founder's post that gives an address, or a listing whose company publishes a hiring
address (jobs@, careers@, hiring@ ...) in the listing or on its own website. An address is
never guessed. The email is the pitch the Cop Tool passed, greeted and signed, with the CV
attached; it counts as the company's one application, and at most `email.max_per_day` go
out a day. After every run that leaves something new for you, you are emailed one table
of everything that needs you (a question only you can answer, an application that may or
may not have gone through, a gap in your profile), each row linked to where to deal with
it. A site that asks for a human check on one application is never paused: every other
application to it is still drafted and tried.

**Emailed codes.** Greenhouse sometimes takes an application only after you enter a code it
emails you "to confirm you are not a robot". A hands-free run never waits for one: with
`apply.code_handoff: true` the application is held, with nothing sent, and keeps its
company. The overview shows *Waiting for a code*; on the application's page press
**I'm ready** when your inbox is to hand. The running `npm run wake` loop fills the form in
again and presses Submit within seconds, and the code the site emails appears on the page:
read from your inbox when Reygent can read it (its app password stored in Settings), or
pasted by you. It is entered only when you press **Approve**, one application at a time,
and the card waits `apply.code_wait_minutes` for you before the application goes back to
waiting.

- **A login, MFA prompt or CAPTCHA challenge.** It does not bypass or solve one. The
  application is marked *needs you*; `npm run reygent -- assist` opens each such form in a visible Chrome window,
  already filled in, for you to finish.

  Most application forms also carry an *invisible* CAPTCHA that only runs when Submit is
  pressed. Reygent presses Submit and the site's own check decides; if a challenge then
  appears, it stops. A site may still quietly discount a submission under its own checks.
  `stop_at_invisible_captcha: true` makes every such form wait for your click.
- **A listing that names a country** ("Remote, Poland") when the investigation cannot
  confirm a contractor elsewhere can be engaged. It is parked for you to qualify or
  disqualify; only a merely vague "Remote" listing is applied for unsettled.
- **A required question your data cannot answer.** Very few are left. Work status is
  worked out from where you live and the listing: authorized to work only in your own
  country, no sponsorship needed to work from there (but needed to be employed anywhere
  else), never relocating, glad to work as a B2B contractor; "the country you are applying
  to" follows whether the listing is open to someone in your country. Privacy notices are
  confirmed; your pronouns and other self-identification are declined unless your notes
  state them; your current title and employer come from your work history; a skill,
  degree or kind of role your CV does not show is answered "No" (add it to the CV and the
  answer follows). Opinions, ways of working, "why us" and light questions are written in
  your voice from your verified work, and a "tell us about a time" story is told from one
  real achievement and replaced by it if it adds an incident that never happened. What is
  still held: robot checks ("paste the secret from this page"), a pledge not to use AI
  (unless `agent.apply_where_ai_is_forbidden: true`), and a fact about you no data
  settles (was a past employer an early-stage startup?).
  Every answer is still checked by the Cop Tool. Answer a held one once on the **Answers**
  page and it is used from then on. Whenever your
  profile, screening notes, fact bank or one of your own answers changes, every held draft
  is written again on the next cycle without your asking; with nothing changed it would
  only be held again, so it waits.
- **A field it cannot fill.** A location box whose search knows nothing near you, a
  question that takes several ticks, a cover letter as a file. The rest of the form is
  filled; `assist` hands you the window.

**The browser agent.** Where the fixed patterns run out, the writing model reads the page
and decides what to press: an Apply button worded another way, a pop-up or overlay over
the posting, a cookie banner, a form that opens in a dialog or a new tab, a form in steps
("Continue", "Next"), a field the patterns did not recognise, a Submit button called
"Send". It sees the page as a short list of buttons and fields, not screenshots, and acts
one step at a time. What it types is only ever one of your details, the draft's cover
note or its screening answers, picked by key; a question it meets on a later step is
answered from your data by the drafting rules and checked by the Cop Tool first
(`agent.answer_new_questions`). Everything it may do is in the `agent` section of
config.yaml: which buttons it never presses (`never_click`), what it does with cookie
banners, whether it follows a listing to another site, whether it feeds the "Autofill
from resume" box, its step and spending limits per application, and whether it applies
through forms that ask applicants not to use AI. It does not get past a sign-in, a CAPTCHA
or any other check that the applicant is a person.

Expect a good share of first applications to stop at one of the last two. Real forms ask
company-specific questions ("how did you hear about us?", "are you over 18?", essay
prompts), and Reygent will not invent an answer. Each one you answer is remembered, and
richer screening notes answer most of the factual ones before they are asked.

One application per company — the best match, and no other. Of several openings at a
company only the best-fitting is drafted, and only once all of them have been judged, so
the best is known. Nothing more goes to that company while the application is alive (being
prepared, held, waiting on you, or sent and not turned down), nor within 30 days of
anything sent there.
- **A draft the Cop Tool rejects** after two repair attempts. It is held in **Quarantine**
  with every rule that fired.
- **Founder-direct pitches.** Reygent writes them (not hands-free) but has no way to send
  email or direct messages; send it yourself and mark it sent.

`pipeline` in Settings puts you back in the loop when you want that:
`require_human_review: true` makes every draft wait for approval, and `auto_submit: false`
fills each form in a visible window and leaves Submit to you.

## The console

| Page | What it is for |
| --- | --- |
| Overview | Setup checklist, what the last cycle did, pipeline counts, today's spend, income secured against the goal |
| Applications | Every listing with its tier, stage, fit, draft and full history; approve, decline, mark sent, record replies, interviews and offers |
| Answers | What Reygent says on your behalf to screening questions. Correct any of them; your answer always replaces the AI's |
| Activity | Every action taken, newest first |
| Quarantine | Drafts the Cop Tool refused to send, the rules that fired, and the draft itself |
| Costs | Spend against the daily cap, 14-day history, per-model totals, every call |
| Profile / Fact bank / Settings | Everything in `config.yaml`, plus API keys, the pipeline mode and the job sources |

Saving rewrites `config.yaml` (the previous version is kept as `config.yaml.bak`; comments
are not preserved). The console listens on 127.0.0.1 only and refuses requests that do not
come from its own page. It never drives the browser and never submits anything: only the
command-line pipeline does.

## Commands

```bash
npm run wake                  # everything: the console, the pre-flight, then the pipeline
npm run web                   # the console alone
npm run reygent -- check      # pre-flight: profile, keys, a live call to each model API, Chrome
npm run reygent -- run        # the pipeline alone, continuously (Ctrl+C to stop)
npm run reygent -- cycle      # one cycle
npm run reygent -- discover   # fetch and classify listings only: free, no browser, no model calls
npm run reygent -- assist     # finish the applications that need you, in a visible Chrome window
npm run reygent -- status     # jobs by stage, what is waiting on you, the last cycle
npm run reygent -- tune <listing>  # tune your CV to one listing and check it reads back (nothing is sent)
npm run reygent -- cost-summary
npm run reygent -- init       # sync config.yaml into the fact bank and list what is missing
npm test                      # the test suite
```

`--config <path>` and `--db <path>` (before the command) override the config file and the
database. On `wake`, `run` and `cycle`, `--watch` fills forms in a visible window and never
presses Submit itself, and `--no-browser` does everything except read forms and apply.

## Where things live

| Path | What |
| --- | --- |
| `config.yaml` | Your profile, fact bank and settings. Git-ignored. Read from the folder you run in, or `$REYGENT_CONFIG` |
| `~/.reygent/reygent.db` | Every listing, evaluation, draft, dispatch, outcome and paid call |
| `~/.reygent/secrets.json` | API keys (an environment variable, if set, takes precedence) |
| `~/.reygent/browser_profile/` | The Chrome profile the pipeline uses, so sign-ins persist |
| `~/.reygent/resumes/<job>/` | The resume each application carried, named for you (`Your-Name-Resume.pdf`): your CV tuned to that listing, a copy of your CV file, or the generated one |
| `~/.reygent/resumes/tuned/<listing>/` | CVs written by `tune`, for you to look at or send yourself |
| `~/.reygent/evidence/` | For each hands-free submission: `<id>-form.png`, the filled form just before Submit, and `<id>.png`, the confirmation page |
| `~/.reygent/console.log` | Output of the console that `wake` started |

## How the invariants are enforced

**3-tier eligibility.** Deterministic and free. A listing is ineligible only on *explicit*
restrictive language (citizenship, clearance, "US only", local payroll, on-site, a rate
under your floor). The location field outranks the description: a role listed as
"Remote, Canada" is not confirmed by company boilerplate about a globally distributed team.
A listing that is merely vague is investigated, never discarded.

**Cost ledger and circuit breaker.** Every paid call reserves its worst-case cost in the
same transaction that checks the day's total, then settles to what was billed. A call that
would take the day past the cap is refused before any request is sent. The first refusal
trips the breaker, fires one macOS notification and pauses paid steps until the budget day
rolls over (midnight in Cameroon); the free steps carry on.

**The Cop Tool.** Nine checks on every draft before it can leave: fact grounding, screening
answers, links, PDF integrity, commitments, rate floor, scam signals, 30-day
de-duplication and tone. Violations a rewrite can repair get up to two attempts;
everything else is quarantined. Two rules are deliberately strict:

- *Fact grounding* — every figure, technology and employer in generated text must appear in
  your verified bank or screening notes, and a CV bullet may only use figures from the
  achievement it cites. The only technologies ever named as yours are the skills you list
  and those of your verified achievements; the four positioning profiles decide which of
  your work to lead with, and add no claims of their own.
- *Screening answers* — an answer about work status, tax, legal standing or identity is
  sent only when it is your own remembered answer, a verbatim profile fact, a decline
  option, or an AI answer that an independent check supports from your data.

**The browser.** Runs your installed Chrome with a persistent profile. It types only what
the draft contains, picks an option only when its text equals the answer exactly, uploads
only the generated resume, checks that every field still holds what it put there, and
presses Submit only when every required field is filled and the button says so in words.
Unattended, it does not touch a form it already knows it cannot complete. Chrome is closed
between cycles.

It has been tested on local copies of Greenhouse, Ashby and Lever forms and read (never
filled) on the live ones. The first real applications are the first real fills: start with
`--watch`.

## Prices

The ledger meters real usage, so these only matter for planning:

- **Jev** (typed decisions): $0.042 per 1M input tokens, output free — about $0.00002 a decision.
- **Fireworks** (writing): DeepSeek V4.1 Flash by default, at $0.30 per 1M input tokens and
  $1.20 per 1M output tokens. A model without an entry in
  `fireworks.pricing_usd_per_million` is refused rather than run unmetered. Tuning a CV
  is three short writing calls per draft (reading the listing, proposing swaps, writing
  the summary) and a few decisions to check them: about a tenth of a cent in all.
- **The browser agent** uses the same model. A decision is one call of about 2,000
  tokens; tried on fixture forms (a pop-up and cookie banner, a three-step form, a
  listing that opens the form in a new tab) it took one to five decisions an application,
  at $0.0002–0.0012 each application. `agent.max_usd_per_application` caps it.

## Not built

- Sending email or direct messages (founder-direct and recruiter pitches are written, not sent).
- Discovery from X, Discord, LinkedIn or any site that needs a login, an API key or a
  browser to get past bot protection.
- Reading replies: you record responses, interviews and offers in the console.

## License

[MIT](LICENSE)
