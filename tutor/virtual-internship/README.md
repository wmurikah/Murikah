# Murikah Tutor — Virtual Internship + Competency Passport

Status: FOUNDATION SPECIFICATION — implementation must follow this document.

Owner surface: Murikah Tutor

Primary learner navigation: **Virtual Internship**

Evidence layer: **Competency Passport**

Minimum standard internship duration: **90 calendar days**. A standard internship must not issue a completion report, completion letter, or completed-internship status before the learner has reached the minimum duration and the required evidence gates. Development/demo fixtures may compress time, but they must be clearly marked as non-qualifying and must never generate a completion credential.

---

## 1. Implementation contract

Before modifying Virtual Internship, Competency Passport, internship assessment, scenario generation, workplace actors, internship persistence, internship reports, or related Tutor navigation, read this document in full.

Do not silently change these product invariants:

1. A Virtual Internship is a persistent simulated workplace, not an ordinary chat mode.
2. A standard internship lasts at least 90 calendar days.
3. The simulated company and its facts have canonical state. AI may animate the world, but it must not be the sole source of truth.
4. Work is organized around assignments, deadlines, meetings, messages, events, evidence and artifacts.
5. Workplace actors behave as workplace actors. The Murikah Mentor is the teaching layer and must remain distinct.
6. Assessment must be evidence-based. A model opinion without traceable evidence is not sufficient to award a competency.
7. Competency Passport entries must retain lineage to tasks, artifacts, rubric criteria, assessment events and assistance level.
8. AI assistance must be recorded because high assistance and independent performance are not equivalent evidence.
9. Workplace politics may be simulated when educationally useful, but never as random cruelty, identity-based targeting, humiliation, or unsafe harassment.
10. Completion reports and letters must state that the experience is a Murikah simulated/virtual internship. They must never impersonate a real employer or imply real employment where none occurred.
11. The feature should be career-extensible. The architecture must not hard-code one profession.
12. Careers whose core competency cannot be meaningfully assessed without physical equipment, direct patient contact, controlled machinery, hazardous environments, or other real-world hardware may use desk-based/support scenarios only. Murikah must not claim simulation has validated the physical competency.
13. The feature uses AI models, but critical state, scoring rules, duration, evidence lineage, permissions and completion gates must remain deterministic and auditable.
14. A learner's internship state must survive logout, deployment, model/provider changes and container replacement.
15. Virtual Internship must not weaken existing Tutor authentication, guest limits, D1/R2 persistence, model-provider boundaries, or other Tutor capabilities.

If an implementation request conflicts with one of these invariants, the PR must explicitly identify the conflict and update this specification in the same change.

---

## 2. Product definition

A Murikah Virtual Internship is a persistent, scenario-driven simulated workplace in which a learner performs authentic role-specific work over at least three months, interacts with simulated colleagues and stakeholders, receives realistic assignments and changing circumstances, produces work products, receives coaching and review, learns through practice, and accumulates traceable competency evidence.

The experience should feel closer to joining a real organization than taking a course.

The learner should experience:

- onboarding;
- role expectations;
- reporting lines;
- recurring work;
- new assignments;
- competing priorities;
- meetings;
- email/message traffic;
- incomplete information;
- ambiguity;
- deadlines;
- rework;
- supervisor feedback;
- stakeholder requests;
- occasional conflict;
- ethical dilemmas;
- workplace politics;
- performance check-ins;
- learning moments;
- progression in responsibility;
- final evaluation.

The experience should not reduce to a stream of prompts such as "pretend you are an intern and answer this question."

---

## 3. Product goals

Virtual Internship should help a learner demonstrate that they can apply knowledge in realistic work situations.

The system should:

- bridge study and work;
- expose learners to role-specific workflows before or alongside real placements;
- let learners build evidence of applied competence;
- make progress visible over a long period;
- support employability and career exploration;
- create authentic work products;
- develop judgment, communication and professional behavior;
- give learners realistic consequences for weak decisions without causing real-world harm;
- help institutions assess readiness;
- generate a defensible end-of-internship performance record;
- feed a durable Competency Passport.

---

## 4. Non-goals

Virtual Internship is not:

- a replacement for legally required industrial attachment, clinical placement, apprenticeship, licensure practice, or supervised physical training;
- proof that a learner can operate machinery, perform surgery, drive a vehicle, repair electrical systems, or carry out any safety-critical physical task;
- a generic role-play chat;
- a course-completion certificate generator;
- an ungrounded personality score;
- an AI-generated employability score with no evidence trail;
- a fake employer;
- a system for manufacturing references that imply a real company employed the learner;
- workplace surveillance;
- a keystroke or screen-monitoring product.

---

## 5. Duration and work rhythm

### 5.1 Minimum duration

A standard Virtual Internship must last **at least 90 calendar days** from the recorded internship start time.

The product may organize this as approximately 12–13 weeks of work, but the completion gate is based on calendar duration plus evidence requirements.

The system must store:

- start timestamp;
- target end timestamp;
- actual completion timestamp;
- active days;
- inactive days;
- approved pause/leave periods if supported;
- weekly progression;
- milestone status.

A learner may finish required assignments early, but cannot receive a qualifying completion status before the minimum duration.

### 5.2 Workload

Each internship defines an expected weekly workload, for example:

- light: 3–5 hours/week;
- standard: 6–10 hours/week;
- intensive: 10–15 hours/week.

These are learning-work expectations, not employee timekeeping.

The system should track meaningful engagement, not mouse movement.

### 5.3 Simulation calendar

The internship has its own work calendar.

Events may be:

- time-triggered;
- milestone-triggered;
- task-triggered;
- dependency-triggered;
- assessor-triggered.

Normal learning mode should preserve the real 90-day completion minimum.

A developer/demo mode may accelerate events for testing, but must be impossible to confuse with a qualifying internship.

---

## 6. Career coverage

The architecture must support any career that can be meaningfully simulated through digital work, reasoning, communication, documents, analysis, planning, design, research, code, records, decisions, or knowledge work.

Initial and future scenario families may include:

- accounting;
- internal audit;
- external audit support;
- finance;
- banking;
- credit;
- insurance operations;
- actuarial analysis;
- investment research;
- economics;
- data analysis;
- data science;
- software engineering;
- software QA;
- product management;
- UX research;
- UI/UX design;
- cybersecurity analysis;
- information security governance;
- IT service management;
- cloud operations planning;
- business analysis;
- project management;
- program management;
- procurement;
- supply-chain planning;
- logistics coordination;
- inventory planning;
- operations analysis;
- human resources;
- payroll administration;
- talent acquisition;
- learning and development;
- legal research;
- compliance;
- governance;
- risk management;
- policy analysis;
- public administration;
- development-sector program work;
- NGO program operations;
- monitoring and evaluation;
- research assistance;
- academic research support;
- journalism;
- communications;
- public relations;
- marketing;
- digital marketing;
- content strategy;
- customer success;
- sales operations;
- business development;
- entrepreneurship;
- consulting;
- hospitality administration;
- tourism planning;
- event management;
- education planning;
- instructional design;
- curriculum support;
- architecture/design-office work that does not purport to validate physical-site competence;
- engineering design/analysis work that does not purport to validate workshop, field, plant or equipment competence;
- healthcare administration, health informatics, research, documentation and policy work that does not simulate unsupervised clinical practice;
- environmental analysis and ESG work;
- quality management;
- records management;
- office administration;
- other digitally assessable knowledge-work careers.

The catalog must be data-driven so new careers can be added through scenario packs rather than hard-coded UI changes.

---

## 7. Careers requiring physical competence

A career may contain both digitally simulatable and physical competencies.

For example, Murikah may simulate:

- an engineer reviewing drawings;
- a laboratory analyst interpreting supplied results;
- a clinician documenting a fictional case;
- a mechanic planning diagnosis from supplied sensor data;
- a construction manager reviewing a project plan.

It must not claim the learner has demonstrated:

- physical examination skill;
- real patient care;
- machinery operation;
- laboratory handling;
- driving;
- live electrical work;
- hazardous-material handling;
- surgery;
- physical installation;
- physical repair quality;
- other competencies whose validity depends on actual hands-on performance.

The Competency Passport must label evidence scope accurately.

---

## 8. Internship lifecycle

A standard lifecycle is:

1. Explore careers.
2. Choose internship.
3. Review role and commitment.
4. Start internship.
5. Company onboarding.
6. Team and reporting-line introduction.
7. Systems/policy orientation.
8. Baseline readiness assessment.
9. First work assignment.
10. Ongoing work cycle.
11. Weekly learning reflection.
12. Supervisor check-in.
13. Progressive assignment difficulty.
14. Midpoint performance review.
15. Increasing autonomy.
16. Capstone assignment/project.
17. Final review and, where appropriate, viva/presentation.
18. Completion gate.
19. Internship Performance Report.
20. Virtual Internship Completion Letter.
21. Competency Passport update.
22. Suggested next development actions.

The implementation must persist the learner's position in this lifecycle.

---

## 9. Simulated company/world model

Every internship belongs to a scenario pack.

A scenario pack should be able to define:

- organization name;
- sector;
- country/region context;
- organization description;
- products/services;
- customers;
- departments;
- organization chart;
- learner role;
- reporting line;
- actors;
- policies;
- processes;
- systems;
- vocabulary;
- calendar;
- work hours;
- communication norms;
- files;
- historical records;
- datasets;
- current problems;
- hidden ground truth;
- task graph;
- event graph;
- rubrics;
- competency mappings;
- difficulty curve;
- escalation paths;
- ethical constraints;
- completion requirements.

Canonical scenario truth must be stored separately from model-generated dialogue.

A model must not silently rewrite established facts.

---

## 10. Workplace actors

Supported actor classes may include:

- supervisor;
- manager;
- colleague;
- peer intern;
- direct report where appropriate;
- client;
- customer;
- vendor;
- regulator;
- auditor;
- HR representative;
- executive;
- project sponsor;
- reviewer/QA;
- board/committee member;
- external stakeholder.

Each actor has:

- role;
- authority;
- goals;
- knowledge boundary;
- communication style;
- relationship to learner;
- scenario facts they may disclose;
- facts they do not know;
- events they can trigger;
- escalation behavior.

Actors should not become omniscient tutors.

If the learner asks a simulated CFO a teaching question, the CFO should answer in-character and within the CFO's role. Educational explanation belongs to the Murikah Mentor.

---

## 11. Murikah Mentor

The Mentor is distinct from the workplace simulation.

The learner can ask the Mentor for:

- concept explanations;
- examples;
- skill coaching;
- planning help;
- reflective questions;
- feedback before submission where permitted;
- explanation of supervisor comments;
- study resources;
- practice.

The Mentor must not automatically complete assigned work.

The system records assistance level for each assessed artifact.

Suggested assistance levels:

- 0 — independent;
- 1 — clarification only;
- 2 — light coaching;
- 3 — moderate coaching;
- 4 — substantial coaching;
- 5 — solution-level assistance.

Competency evidence derived from heavily assisted work must be weighted differently from independent work.

---

## 12. Workplace politics and social dynamics

Real work includes incentives, status, disagreement and ambiguity. The simulation should include a controlled amount of workplace politics where it teaches professional judgment.

Useful examples include:

- competing departmental priorities;
- unclear ownership;
- a colleague taking credit;
- a manager changing priorities;
- a stakeholder withholding information;
- tension between speed and control;
- disagreement between two managers;
- informal influence;
- pressure to soften a finding;
- resistance to change;
- deadline bargaining;
- scope creep;
- budget competition;
- favoritism perceptions;
- conflicting performance incentives;
- a difficult review meeting;
- someone bypassing the learner's reporting line;
- an ethical request that should be challenged or escalated.

Politics must serve a learning objective.

The system must not create random abuse simply to make the simulation "realistic."

Prohibited simulation behavior includes:

- identity-based harassment as entertainment;
- sexual harassment role-play directed at the learner;
- threats of real-world harm;
- humiliation loops;
- retaliation designed only to distress the learner;
- discriminatory scoring;
- coercion to disclose private real-life information.

Where a scenario includes an ethics, misconduct, discrimination, safeguarding or whistleblowing issue for legitimate learning purposes, it should be clearly bounded, professionally framed, and provide appropriate escalation choices.

---

## 13. Task model

The task is the core unit of work.

Each task should support:

- task ID;
- title;
- category;
- assigned-by actor;
- business context;
- learner objective;
- brief;
- deliverables;
- available evidence;
- hidden ground truth;
- dependencies;
- due date;
- expected effort;
- difficulty;
- competencies assessed;
- rubric;
- allowed tools;
- allowed mentor support;
- stakeholder contacts;
- events triggered by progress;
- completion criteria;
- revision rules;
- assessment state.

Tasks can be:

- routine;
- analytical;
- investigative;
- creative;
- communication-based;
- planning;
- research;
- coding;
- review;
- decision-making;
- crisis/incident;
- presentation;
- capstone.

Not every task should be a crisis. Real work includes recurring routine work.

---

## 14. Work artifacts

Important assessed tasks should normally produce evidence-bearing artifacts.

Examples:

- memo;
- report;
- working paper;
- spreadsheet;
- CSV analysis;
- notebook;
- SQL;
- code;
- pull request;
- test plan;
- presentation;
- requirements document;
- risk register;
- policy draft;
- email;
- client response;
- meeting notes;
- research brief;
- marketing plan;
- financial model;
- reconciliation;
- audit finding;
- credit memorandum;
- procurement evaluation;
- project plan;
- design brief;
- dashboard;
- incident report;
- data-cleaning output.

Each artifact should retain:

- artifact ID;
- internship ID;
- task ID;
- learner;
- version;
- submitted timestamp;
- file/object location;
- content hash where practical;
- evaluator result;
- rubric score;
- feedback;
- revisions;
- assistance level;
- competency evidence created from it.

---

## 15. Inbox, meetings and communication

The internship should include a workplace inbox/timeline.

Events may include:

- task assignment;
- supervisor message;
- colleague message;
- meeting invitation;
- stakeholder response;
- document request;
- deadline reminder;
- review comments;
- escalation;
- client requirement change;
- policy update;
- performance check-in.

Communication should be stateful. If a learner asks a stakeholder a question, the response becomes part of the internship record.

Future releases may support simulated calls/voice meetings, but text-based communication must be sufficient for the base product.

---

## 16. Event engine

Scenario events must be deterministic enough to be reproducible and auditable.

Triggers may include:

- elapsed internship time;
- task completion;
- missed deadline;
- rubric result;
- learner decision;
- stakeholder request;
- random choice from a bounded authored set;
- model-proposed variation that passes schema validation.

Examples:

- new evidence contradicts a prior conclusion;
- client changes requirements;
- supervisor requests a status update;
- another team disputes ownership;
- a deadline moves;
- an employee becomes unavailable;
- management challenges a finding;
- project scope expands;
- a high-priority task interrupts routine work.

The event engine must not let an LLM invent irreversible scenario facts without validation and persistence.

---

## 17. Learning and work tracking

The system should track the internship as both work and learning.

Track:

- active internship days;
- meaningful activity sessions;
- tasks assigned;
- tasks accepted;
- tasks completed;
- overdue tasks;
- artifacts submitted;
- revision count;
- meetings attended;
- messages sent/received;
- evidence requests;
- decisions;
- escalations;
- mentor consultations;
- assistance level;
- feedback received;
- feedback acted upon;
- rubric results;
- competencies attempted;
- competencies demonstrated;
- repeated weaknesses;
- improvement trend;
- reflection entries;
- supervisor reviews;
- midpoint review;
- final review.

Do not track invasive telemetry such as every keystroke simply to create the appearance of rigor.

---

## 18. Reflection and learning journal

At least weekly, the learner should complete a short reflection.

Prompts can include:

- What did I work on?
- What was difficult?
- What did I learn?
- What decision would I change?
- What feedback did I receive?
- What evidence supports my conclusion?
- What will I do differently next week?

AI may summarize patterns, but the original learner reflection should remain available.

The learning journal feeds the final report but is not a substitute for work evidence.

---

## 19. Assessment architecture

Assessment combines deterministic rubric logic with AI-supported review.

A single model should not simultaneously:

1. coach the learner;
2. generate the learner's answer;
3. grade the same answer;
4. award the competency with no independent checks.

Preferred separation:

- actor model(s): workplace conversation;
- mentor model: learning support;
- assessor model: artifact/rubric review;
- scenario-director model: controlled event variation;
- deterministic evidence service: final recording and gates.

Where possible, assessor context should not include hidden chain-of-thought or irrelevant mentor dialogue.

The assessor receives:

- task brief;
- rubric;
- artifact;
- permitted scenario facts;
- relevant communication/evidence;
- assistance level;
- prior feedback where necessary.

The assessor returns structured criteria results.

Deterministic code validates schema, ranges, required evidence and completion rules before writing Competency Passport evidence.

---

## 20. AI model use

Virtual Internship is explicitly AI-assisted.

The implementation must use the existing Murikah model/provider abstraction rather than hard-coding a single vendor.

Model roles may have different defaults:

### Fast actor model

Used for:

- routine messages;
- colleague conversation;
- short supervisor replies;
- inbox events;
- low-risk scenario dialogue.

Requirements:

- low latency;
- strong instruction following;
- bounded response length.

### Reasoning model

Used for:

- complex workplace decisions;
- nuanced scenario branching;
- difficult review conversations;
- capstone tasks;
- high-complexity assessments.

### Assessor model

Used for:

- rubric-based artifact review;
- competency evidence proposal;
- written feedback.

It should run with strict structured output.

### Mentor model

Used for:

- explanations;
- coaching;
- Socratic guidance;
- learning reflection.

### Scenario-director model

Used sparingly for:

- creating bounded variations;
- selecting authored events;
- adapting difficulty;
- generating role-appropriate non-canonical wording.

All model calls must have:

- bounded timeout;
- retry policy;
- provider fallback where appropriate;
- structured validation where structured output is expected;
- safe learner-facing errors;
- server-side incident logging;
- no raw provider exception shown to learner.

Store model metadata needed for auditability, such as model/profile identifier and evaluation version, without storing secrets.

---

## 21. Competency model

A competency can contain:

- competency ID;
- name;
- description;
- domain;
- sub-competencies;
- level framework;
- evidence requirements;
- transfer requirements;
- recency rules if relevant.

A recommended progression model is:

- Emerging;
- Developing;
- Applied with support;
- Independent;
- Advanced.

A percentage may be shown for a rubric/task if useful, but the Passport should not pretend an arbitrary percentage alone proves competence.

---

## 22. Competency Evidence Record

Every awarded competency result must point to evidence.

A Competency Evidence Record should include:

- evidence ID;
- learner ID;
- competency ID;
- sub-competency;
- internship ID;
- scenario pack/version;
- task ID;
- artifact ID(s);
- rubric criteria;
- assessment result;
- level demonstrated;
- assessor/version;
- model metadata if AI-assisted;
- mentor assistance level;
- revision count;
- timestamp;
- evidence strength;
- transfer context;
- any limitation.

No evidence record should be created solely from the statement "the model believes the learner is good at X."

---

## 23. Competency Passport

The Competency Passport aggregates evidence across time.

Initial evidence source:

- Virtual Internship.

Future evidence sources may include:

- Mastery Path;
- projects;
- oral viva;
- instructor assessment;
- external portfolio evidence;
- other Murikah learning experiences.

Passport views should eventually support:

- competency summary;
- level;
- confidence/evidence strength;
- number of supporting artifacts;
- independent vs assisted performance;
- contexts in which competency was demonstrated;
- trend;
- evidence drill-down.

Competency transfer matters. Demonstrating communication in multiple distinct work contexts is stronger than repeating the same scenario.

---

## 24. Midpoint and final performance review

Every standard internship should include at least:

- a midpoint review;
- a final performance review.

Suggested review dimensions:

- quality of work;
- accuracy;
- timeliness;
- communication;
- collaboration;
- initiative;
- problem diagnosis;
- judgment;
- evidence use;
- response to feedback;
- professionalism;
- ethics;
- role-specific technical competency;
- independence.

The review should cite concrete examples from the internship.

---

## 25. Final Internship Performance Report

When completion gates are met, Murikah should generate a detailed report.

The report should contain:

- learner name;
- internship title;
- simulated organization;
- internship dates;
- total duration;
- expected workload band;
- role summary;
- key assignments;
- work products completed;
- performance review;
- competency summary;
- strengths;
- development areas;
- evidence highlights;
- assistance/independence context;
- midpoint-to-final improvement;
- supervisor-style narrative;
- learner reflection summary;
- limitations statement;
- verification/reference identifier.

The report must clearly state that it covers a Murikah Virtual Internship simulation.

---

## 26. Virtual Internship Completion Letter

A completed internship may generate a concise letter suitable for the learner's portfolio.

The letter may state that the learner:

- completed the named Murikah Virtual Internship;
- participated for the recorded dates;
- performed specified categories of simulated work;
- completed specified deliverables;
- demonstrated listed competencies at stated evidence levels.

The letter must not:

- state that the learner was employed by the fictional company;
- use a fictional executive's signature in a way that could be mistaken for a real employer reference;
- imply statutory industrial attachment approval unless an authorized institution has actually provided that status.

A future institution mode may allow an authorized school/university/TVET provider to co-sign or endorse the report through a separate verified workflow.

---

## 27. Persistence and data model

Persistent state should eventually include at minimum:

- internship_instances;
- internship_memberships;
- scenario_packs;
- scenario_versions;
- scenario_actors;
- scenario_documents;
- internship_tasks;
- internship_task_events;
- internship_messages;
- internship_meetings;
- internship_artifacts;
- internship_artifact_versions;
- internship_feedback;
- internship_reflections;
- internship_reviews;
- internship_activity;
- competency_definitions;
- competency_evidence;
- competency_passports;
- completion_records.

Exact table names may change, but the logical separation should remain.

Use D1 for structured state and R2 for larger artifacts/files where consistent with the Tutor persistence architecture.

Persistence operations must be actor-bound and must not leak one learner's internship to another learner.

---

## 28. Scenario pack format

Scenario packs should eventually be versioned, portable and testable.

A conceptual pack may contain:

```text
scenario/
  manifest.json
  company.json
  organization.json
  actors.json
  competencies.json
  tasks.json
  events.json
  rubrics.json
  completion.json
  documents/
  datasets/
  templates/
```

A pack should declare:

- schema version;
- title;
- career family;
- role;
- region/context;
- minimum duration;
- expected workload;
- required competencies;
- task graph;
- event graph;
- available AI roles;
- final completion gates.

Scenario pack changes after learners start must use versioning rather than silently changing historical truth.

---

## 29. Institution-created internships

Future institution/admin functionality may allow authorized users to:

1. choose a career/role template;
2. upload learning outcomes;
3. upload rubrics;
4. upload source documents;
5. define duration/workload;
6. configure competencies;
7. generate a draft company/scenario using AI;
8. review and approve canonical facts;
9. publish a versioned scenario pack;
10. assign it to learners/cohorts.

AI-generated scenario packs must not become live without schema validation and an approval/review step.

---

## 30. Guest and member behavior

Virtual Internship is a long-lived experience and therefore requires a verified member account to start.

Guests may see the **Virtual Internship** navigation item and a product preview.

Guests must not:

- start a qualifying internship;
- accumulate Passport evidence;
- receive a completion report;
- receive a completion letter.

If a guest chooses Virtual Internship, the product should preserve the guest session and route them through account creation/sign-in before starting.

A member may have:

- one or more past internships;
- one active internship by default in the first release;
- future support for multiple concurrent internships only if explicitly designed.

---

## 31. UX surfaces

The mature feature is expected to include:

### Virtual Internship home

- internship status;
- simulated company;
- role;
- current week/day;
- progress;
- current priorities;
- upcoming deadlines;
- recent feedback.

### Inbox

- messages;
- task assignments;
- meeting invitations;
- review feedback;
- scenario events.

### Work

- active tasks;
- backlog;
- completed work;
- deadlines;
- dependencies.

### Company

- organization profile;
- org chart;
- people;
- policies;
- processes;
- systems;
- reference documents.

### Mentor

- learning help;
- coaching;
- reflection.

### Reviews

- midpoint;
- supervisor feedback;
- final performance review.

### Competency Passport

- competencies;
- evidence;
- artifacts;
- independent/assisted context;
- progress.

---

## 32. Initial placeholder behavior

The first implementation after this specification is intentionally small.

It must:

- add **Virtual Internship** to Tutor navigation;
- provide a dedicated `/virtual-internship` placeholder for authenticated users;
- expose a guest-visible entry that routes through sign-up/sign-in;
- state the 3+ month design;
- mention persistent simulated work, AI workplace actors, assessed artifacts and Competency Passport;
- make clear that the full workflow is not yet enabled;
- not create fake internship records;
- not create placeholder competency evidence.

This placeholder is the navigation anchor for subsequent implementation phases.

---

## 33. Build sequence / implementation checklist

Each checkbox should normally be completed in order. A PR may cover one or several items, but it must update this checklist when a milestone becomes real.

### Phase 0 — product contract and placeholder

- [x] Write canonical Virtual Internship + Competency Passport specification.
- [x] Add authenticated Tutor sidebar entry.
- [x] Add authenticated `/virtual-internship` placeholder route.
- [x] Add guest-visible Virtual Internship entry.
- [x] Add build/preflight checks protecting the placeholder and specification.

### Phase 1 — persistence foundation

- [x] Define internship/scenario D1 schema.
- [x] Define R2 artifact paths.
- [x] Add migrations.
- [x] Add actor-bound persistence adapter methods.
- [x] Add ownership/isolation tests.
- [x] Add scenario versioning.
- [x] Add internship start/stop/status APIs.
- [x] Enforce 90-day qualifying-duration rule in backend code.

### Phase 2 — scenario engine

- [x] Define scenario-pack JSON schemas.
- [x] Build schema validation.
- [x] Build canonical scenario-state service.
- [x] Build actor knowledge boundaries.
- [x] Build task graph.
- [x] Build event graph.
- [x] Build deterministic event triggers.
- [x] Add demo scenario fixtures.
- [x] Ensure AI cannot silently overwrite canonical truth.

### Phase 3 — AI orchestration

- [x] Add model-role abstraction for actor, mentor, assessor and scenario director.
- [x] Reuse Murikah provider/model configuration.
- [x] Add bounded timeouts.
- [x] Add retry/fallback.
- [x] Add structured-output schemas.
- [x] Add learner-safe failure messages.
- [x] Add model/audit metadata.
- [x] Test provider failure and malformed structured output.

### Phase 4 — internship workplace UI

- [x] Build Virtual Internship dashboard.
- [x] Build inbox.
- [x] Build task/work queue.
- [x] Build company/people view.
- [x] Build document/evidence browser.
- [x] Build meetings/timeline.
- [x] Build Mentor surface.
- [x] Build activity/reflection view.
- [x] Preserve responsive/mobile behavior.

### Phase 5 — work artifact workflow

- [x] Assignment open/acknowledge.
- [x] Artifact drafting/upload.
- [x] Submission.
- [x] Version history.
- [x] Supervisor review.
- [x] Revision/resubmission.
- [x] Completion.
- [x] R2 object ownership.
- [x] Artifact integrity metadata.

### Phase 6 — assessment and workplace dynamics

- [x] Rubric engine.
- [x] Structured assessor.
- [x] Assistance-level recording.
- [x] Midpoint review.
- [x] Final review.
- [x] Workplace politics event library.
- [x] Ethics/escalation events.
- [x] Bias/fairness guardrails.
- [x] Evidence-based feedback tests.

### Phase 7 — Competency Passport

- [ ] Competency definitions.
- [ ] Competency Evidence Record.
- [ ] Evidence-strength rules.
- [ ] Independent vs assisted weighting/context.
- [ ] Cross-task evidence aggregation.
- [ ] Cross-internship transfer.
- [ ] Passport UI.
- [ ] Evidence drill-down.
- [ ] Export.

### Phase 8 — 90-day completion system

- [ ] Duration gate.
- [ ] Required-task gate.
- [ ] Required-review gate.
- [ ] Evidence gate.
- [ ] Capstone/final review gate.
- [ ] Completion state machine.
- [ ] Prevent demo/test internships from issuing qualifying completion.

### Phase 9 — reports and letters

- [ ] Internship Performance Report.
- [ ] Virtual Internship Completion Letter.
- [ ] Evidence references.
- [ ] Simulation disclosure.
- [ ] Verification/reference ID.
- [ ] PDF/export if required.
- [ ] Institution endorsement extension point.

### Phase 10 — career catalog

- [ ] Career-family schema.
- [ ] Search/filter.
- [ ] Scenario template inheritance.
- [ ] Initial Internal Audit internship.
- [ ] Initial Data Analyst internship.
- [ ] Initial Software Engineering internship.
- [ ] Additional career packs.
- [ ] Physical-competency limitation labels.
- [ ] Institution-created scenario workflow.

### Phase 11 — longitudinal evaluation

- [ ] Track learner progression across 90+ days.
- [ ] Track retention/engagement without invasive surveillance.
- [ ] Track skill improvement.
- [ ] Track mentor-dependence reduction.
- [ ] Track transfer across different scenario contexts.
- [ ] Add anonymized analytics appropriate for research/product evaluation.

---

## 34. Testing contract

Every Virtual Internship PR must identify which test layer it affects.

### 34.1 Static/build invariants

Build/preflight should fail if:

- this specification is removed;
- the main navigation entry disappears unexpectedly;
- the placeholder/full route is missing after the overlay is applied;
- a required scenario schema disappears;
- the 90-day completion constant/gate is removed after Phase 8;
- completion output loses the simulation disclosure;
- Competency Evidence Record loses artifact/task lineage after Phase 7.

### 34.2 Unit tests

Unit tests should cover:

- scenario schema parsing;
- task state transitions;
- event triggers;
- actor knowledge boundaries;
- duration calculations;
- completion gates;
- assistance levels;
- rubric calculations;
- evidence aggregation;
- report field construction;
- simulation disclosure.

### 34.3 Persistence tests

Test:

- learner isolation;
- no cross-account artifact access;
- idempotent writes;
- replay safety;
- scenario version retention;
- task/event history;
- artifact version history;
- D1/R2 recovery;
- migration compatibility.

### 34.4 AI contract tests

Use deterministic fixtures/mocks to test:

- actor response schema;
- assessor response schema;
- malformed model output;
- empty model output;
- provider timeout;
- provider fallback;
- model refusal;
- model changing canonical facts;
- evaluator attempting to award unsupported competency;
- mentor assistance recording.

No release should depend solely on a live model behaving correctly during CI.

### 34.5 End-to-end tests

At minimum, mature E2E coverage should exercise:

1. member starts internship;
2. onboarding loads;
3. task assigned;
4. learner asks workplace actor;
5. learner asks Mentor;
6. assistance level recorded;
7. artifact submitted;
8. assessor returns structured review;
9. learner revises;
10. competency evidence created;
11. event triggers;
12. midpoint review;
13. final gate checks;
14. report generated;
15. Passport updated.

### 34.6 Time tests

Use an injectable clock.

Test:

- 89 days does not complete;
- 90 days can complete only if all other gates pass;
- paused time behavior;
- demo mode cannot issue qualifying completion;
- date/timezone boundaries.

### 34.7 Security tests

Test:

- auth required to start;
- guest cannot create evidence;
- one learner cannot read another learner's internship;
- actor prompts cannot reveal hidden ground truth outside allowed role knowledge;
- uploaded artifacts are owner-bound;
- report IDs do not expose secrets;
- AI model keys remain server-side;
- prompt injection in scenario documents does not bypass system rules.

### 34.8 UX/accessibility tests

Test:

- sidebar navigation;
- mobile layout;
- keyboard navigation;
- focus states;
- accessible labels;
- loading states;
- empty states;
- error recovery;
- long inbox/thread scrolling;
- large artifact lists;
- reduced-motion compatibility.

### 34.9 Workplace-politics tests

Scenario tests must confirm:

- politics event has a learning objective;
- learner has at least one reasonable professional response;
- outcome is not based on protected characteristics;
- event can be resolved/escalated;
- scoring follows rubric, not actor "liking" the learner;
- abusive loops are not generated.

### 34.10 Report/Passport tests

Test:

- every claimed competency has supporting evidence;
- deleted/invalid evidence cannot remain silently counted;
- assistance context is present;
- simulation disclosure is present;
- dates match persisted internship state;
- report does not claim real employment.

---

## 35. Release gates

A production release of a new major internship capability should not ship unless:

- build is green for Tutor-specific checks;
- migrations succeed;
- persistence isolation tests pass;
- the scenario schema is versioned;
- AI structured outputs are validated;
- model failure has a safe fallback/error path;
- guest/member boundaries are preserved;
- no raw model/provider exception reaches the learner;
- assessment claims are traceable to evidence;
- the simulation disclosure is intact.

---

## 36. First scenario packs

The first three full scenario packs should be:

1. **Internal Audit Intern**
2. **Data Analyst Intern**
3. **Software Engineering Intern**

These three provide different work patterns, artifacts and assessment types and are useful for proving that the engine is not tied to one profession.

The architecture must still support expansion to the broader career catalog described above.

---

## 37. Definition of done for the full product

Virtual Internship + Competency Passport is not considered complete merely because the learner can chat with simulated employees.

The feature reaches its intended baseline when:

- a verified member can start a persistent 90+ day internship;
- the company and scenario persist;
- tasks/events progress over time;
- multiple workplace actors operate within knowledge boundaries;
- the Mentor can coach separately;
- the learner produces versioned artifacts;
- work receives structured review;
- workplace dynamics include realistic, bounded political/ethical situations;
- assistance level is recorded;
- competencies are backed by evidence;
- the Passport aggregates that evidence;
- midpoint/final reviews exist;
- completion gates are enforced server-side;
- a final performance report is generated;
- a clearly disclosed Virtual Internship Completion Letter is generated;
- at least the first three scenario packs pass the common scenario engine tests.

Until then, the sidebar feature may be visible, but the UI must honestly identify incomplete areas.

---

## Phase 1 Implementation Record

Status: **implemented in Phase 1 only**. This record is the canonical implementation reference for persistence, ownership, lifecycle, scenario versioning and duration behavior. Phase 2 remains unimplemented.

### Storage and migration

The Phase 1 migration is:

`tutor/cloudflare/migrations/0006_virtual_internship_phase1.sql`

It creates exactly these Virtual Internship tables:

- `scenario_packs`
- `scenario_versions`
- `internship_instances`
- `internship_memberships`
- `internship_activity`

D1 remains authoritative for structured internship state. R2 remains reserved for large/private internship objects and uses the existing Tutor `TUTOR_FILES` binding. Phase 1 does not create task, event, artifact, assessment, Passport, report or completion tables.

The migration adds these principal indexes/constraints:

- `UNIQUE (scenario_pack_id, version)` on scenario versions;
- `UNIQUE (learner_id, start_request_id)` for start idempotency;
- `idx_scenario_versions_pack_status`;
- `idx_internship_instances_learner_status`;
- `idx_internship_instances_scenario_version`;
- partial unique `idx_internship_one_active_qualifying_per_learner`, enforcing one active qualifying internship per learner at the database layer;
- `idx_internship_memberships_actor`;
- `idx_internship_activity_internship_time`;
- partial unique `idx_internship_activity_request` for retry-safe lifecycle activity;
- foreign keys from instances to learner account, scenario pack and scenario version;
- a schema-level `CHECK (completed_at IS NULL)`, so Phase 1 cannot persist a completed transition.

The migration includes one clearly marked minimal published foundation scenario, `foundation-knowledge-work`, version 1. It contains no task graph, event graph, actor engine or fake assignments. Its sole purpose is to make the Phase 1 lifecycle/versioning foundation exercisable end to end.

### Scenario pack and version semantics

`scenario_packs` is the stable conceptual career/internship offering. `scenario_versions` stores immutable published revisions of that offering. Each version has a stable ID, integer version, schema version and minimum-duration policy.

Starting an internship resolves exactly one published scenario version. `internship_instances.scenario_version_id` is written once at creation. No Phase 1 API updates it. Publishing a later version therefore does not mutate historical internships. Existing records continue to resolve their originally pinned scenario version.

Draft or retired scenario versions are not startable through the Phase 1 resolver.

### Internship lifecycle and membership

Phase 1 exposes only these lifecycle states:

- `active`
- `stopped`

`stopped` means withdrawn/stopped, not completed. Phase 1 exposes no learner-controlled completed transition, creates no completion record and issues no report, letter, credential or Competency Passport evidence.

A learner may start a new qualifying internship after the prior one is stopped. The restriction is one **active** qualifying internship at a time.

`internship_memberships` creates the authorization boundary. Phase 1 supports one membership role, `learner`, tied to the owning Tutor actor. This is the extension point for future supervisor/institution roles without changing the learner ownership rule.

`internship_activity` is append-oriented and currently records `internship_started` and `internship_stopped`; the schema also reserves `completion_duration_checked` for deterministic duration-gate audit without treating status views as business events.

### Authenticated identity and verified-member gate

The persistence bridge remains HMAC-authenticated under `/__muri/persist/*`. Server-side Tutor code supplies the current authenticated actor ID to the persistence adapter. Browser-supplied `learner_id`, `owner_id` or `user_id` fields are explicitly rejected by lifecycle write routes and are never accepted as proof of ownership.

The Worker validates the actor against the existing `tutor_accounts` D1 record. A qualifying start requires:

- `role = 'member'`;
- `account_status = 'active'`;
- existing `email_verified_at > 0`.

Guests and unverified accounts cannot start qualifying internships.

### Phase 1 APIs and adapter

Worker routes:

- start: `POST /__muri/persist/internships/start`
- status: `GET /__muri/persist/internships/status`
- stop/withdraw: `POST /__muri/persist/internships/stop`
- scenario resolution: `POST /__muri/persist/scenario-version/resolve`
- owner-validated future R2 key construction: `POST /__muri/persist/internships/object-key`

The existing persistence client `tutor/railway/murikah_persistence.py` now provides:

- `scenario_version_resolve(...)`
- `internship_start(...)`
- `internship_status(...)`
- `internship_stop(...)`
- `internship_duration_status(...)`
- `internship_object_key(...)`

No new persistence service, database, identity store or ownership authority was introduced.

### 90-day qualifying-duration contract

The authoritative constant is:

`STANDARD_MINIMUM_INTERNSHIP_DAYS`

in:

`tutor/cloudflare/src/index.ts`

For a qualifying internship:

`effective_minimum_days = max(STANDARD_MINIMUM_INTERNSHIP_DAYS, scenario_version.minimum_duration_days)`

At start, using the Worker UTC epoch clock:

`started_at = server now`

`target_end_at = started_at + effective_minimum_days * 86,400 seconds`

The effective minimum is snapshotted into `internship_instances.minimum_duration_days`.

Therefore:

- scenario minimum 30 days -> qualifying minimum remains 90 days;
- scenario minimum 90 days -> qualifying minimum is 90 days;
- scenario minimum 120 days -> qualifying minimum is 120 days.

The duration helper accepts an injected `nowSeconds` for deterministic tests; production defaults to the Worker UTC clock. It uses elapsed epoch seconds, not Africa/Nairobi midnight or browser time.

For stopped internships, duration stops accruing at `stopped_at`.

`duration_requirement_met` is deliberately distinct from final completion. Phase 1 always returns:

- `final_completion_available: false`
- `pending_future_completion_gates: true`

even after the minimum duration is met.

### Idempotency and concurrency

Start requires a logical `request_id`. `UNIQUE (learner_id, start_request_id)` makes retry of the same logical start return the already-created internship rather than creating another one.

The one-active rule is enforced both by an indexed pre-check and by the partial unique D1 index `idx_internship_one_active_qualifying_per_learner`, so concurrent starts cannot create two active qualifying internships.

Stop is deterministic and retry-safe: stopping an already stopped owned internship returns the existing stopped status. Lifecycle activity uses a request-scoped unique index so replay does not create duplicate business events.

The existing `persistence_replay` table remains the transport-level HMAC nonce replay defense. Phase 1 does not create a competing generic replay database.

### Ownership and isolation

Every learner-specific read or update is ownership-bound in SQL using both internship ID and learner ID. A foreign internship ID returns the same private `internship_not_found` shape and does not reveal foreign metadata.

The canonical future R2 key contract is:

`users/<learner-id>/virtual-internships/<internship-id>/<object-type>/<object-id>`

Allowed Phase 1 reserved object areas are:

- `scenario`
- `documents`
- `artifacts`
- `artifact-versions`
- `exports`
- `reports`

The key helper validates authenticated actor ownership in D1, validates object type and object ID, and never accepts a browser-supplied final R2 key. Traversal/absolute/foreign-prefix construction is therefore not a client capability.

When future phases actually write an internship object to R2, the existing global `tutor_objects` D1 registry remains the authoritative ownership metadata. Phase 1 intentionally does not create a second internship-specific R2 ownership table and does not create empty/fake R2 objects.

### Tests and preflight

Phase 1 regression files:

- `tutor/tests/test_virtual_internship_phase1.py`
- `tutor/tests/test_virtual_internship_ownership.py`
- `tutor/tests/test_virtual_internship_duration.py`

They protect migration shape, route presence, actor-bound adapter behavior, owner-bound SQL, verified-member gating, one-active enforcement, idempotency markers, scenario-version pinning, canonical R2 paths and UTC duration boundaries including month/year/leap-date cases.

Cloudflare preflight protects stable semantic identifiers rather than prose wrapping: the migration filename, table/index names, `STANDARD_MINIMUM_INTERNSHIP_DAYS`, lifecycle route names, persistence adapter methods, test filenames and this implementation-record heading.

### Current Phase 1 limitations

Phase 1 deliberately does **not** implement scenario task/event schemas, company-world execution, workplace actors, Mentor workflow, supervisor/colleague/client AI, workplace-politics engine, assignments, inbox/task UI, artifact submission workflow, rubrics, assessor AI, Competency Evidence Records, Competency Passport scoring, midpoint/final review, report generation, completion letters or a completed-internship credential.

Those remain Phase 2+ work.

---

## Phase 2 Implementation Record

Phase 2 implements the deterministic scenario engine only. It does not implement Phase 3 AI orchestration, workplace actor dialogue, the Murikah Mentor, assessor models, workplace UI, artifact submission, competency scoring, reports, completion letters or final completion.

### Canonical scenario format

The single schema authority is:

`tutor/virtual-internship/schema/v1/scenario-pack.schema.json`

It is portable JSON Schema using draft 2020-12. Phase 2 uses:

`scenario_schema_version = 1`

This is different from the authored scenario content version. A pack may therefore have scenario schema version 1 and scenario content version 3.

The strict core components are:

- `manifest.json`
- `company.json`
- `facts.json`
- `actors.json`
- `tasks.json`
- `events.json`
- `decisions.json`

Core schema objects use `additionalProperties: false`. Stable machine IDs are used for actors, facts, tasks, events and decisions. The Phase 2 hard limits are 64 actors, 128 facts, 128 tasks, 128 events, 64 decisions, 16 dependencies or trigger conditions where the schema applies them, 1 MiB canonical JSON and a maximum deterministic event cascade depth of 16.

The offline validator is:

`python tutor/scripts/validate_virtual_internship_scenarios.py`

It performs JSON Schema validation plus semantic validation for references, duplicate IDs, task DAGs, prior-event cycles, trigger fields, typed mutations, immutable facts, decision options, qualifying-duration rules and content hashes. It requires no network and no model provider.

### Immutable definition snapshot and hash

The canonical content hash is SHA-256 over UTF-8 canonical JSON with:

- object keys sorted recursively;
- array order preserved because authored array order is semantic where sequence is explicit;
- compact JSON separators;
- `manifest.content_hash` blanked before hashing;
- no filesystem timestamps, deployment timestamps or environment-specific paths.

Equivalent JSON key ordering therefore produces the same hash. A semantic content change produces a different hash.

For an engine-ready version, the existing Phase 1 fields remain authoritative:

- `scenario_versions.content_hash` stores the SHA-256 digest;
- `scenario_versions.manifest_ref` is `d1:scenario-version-content/<scenario-version-id>`.

The referenced immutable snapshot is stored in `scenario_version_content`. The Worker verifies that the snapshot hash and `manifest_ref` still match the pinned `scenario_versions` row before initialization or definition retrieval. Published definitions cannot be silently replaced. Draft versions may be installed once through the private HMAC persistence boundary and later published by a controlled release process.

The historical `sv_foundation_knowledge_work_v1` remains unchanged and still has no Phase 2 graph.

### Phase 2 D1 model

Migration:

`tutor/cloudflare/migrations/0008_virtual_internship_phase2.sql`

Immutable authored-definition tables:

- `scenario_version_content`
- `scenario_actors`
- `scenario_facts`
- `scenario_actor_knowledge`
- `scenario_task_definitions`
- `scenario_task_dependencies`
- `scenario_event_definitions`
- `scenario_event_triggers`
- `scenario_decision_options`

Per-internship runtime tables:

- `internship_scenario_state`
- `internship_scenario_facts`
- `internship_tasks`
- `internship_event_state`
- `internship_decisions`
- `internship_event_firings`
- `internship_state_changes`

`internship_activity` remains the Phase 1 lifecycle audit. Scenario task/event changes use dedicated Phase 2 tables so lifecycle events and simulation events do not become one overloaded vocabulary.

No Phase 2 table creates a second learner/owner authority. Runtime rows link to `internship_id`, and member reads/writes resolve ownership through `internship_instances.learner_id`.

### Initialization and start integration

An engine-ready internship is initialized from the exact pinned `scenario_version_id`. Initialization creates:

- one ready runtime state row;
- initial runtime fact values and reveal flags;
- one runtime task row per authored task;
- `available` state for dependency-free tasks;
- `locked` state for tasks with unresolved dependencies;
- one zero-fired runtime row per authored event;
- revision 0 `scenario_initialized` audit history.

The existing Phase 1 `POST /__muri/persist/internships/start` is not replaced. When its selected scenario version has a validated D1 snapshot, the Worker adds the Phase 2 initialization statements to the same D1 batch as the Phase 1 internship, membership and lifecycle insertions. This prevents an engine-ready start from being reported healthy with half-created scenario state.

The recovery initializer is idempotent and returns the existing ready state when initialization has already completed. It does not use process memory as authority.

### Canonical state service and persistence operations

The server-side facade is:

`tutor/railway/virtual_internship/state.py`

It exposes typed operations for definition lookup, initialization, canonical state, actor view, learner view, task transition, bounded decision recording and deterministic event evaluation. Durable operations are implemented through `tutor/railway/murikah_persistence.py` and the existing HMAC-protected `/__muri/persist/*` Worker boundary.

There is no generic `patch_state`, arbitrary JSON merge, client-set fact or public event-fire API.

Canonical raw state is a server/internal view. Later learner UI must consume the learner-safe view, not the canonical truth table.

### Revision, idempotency and concurrency

`internship_scenario_state.revision` is monotonically increasing.

Every accepted state-changing transition writes an append-only `internship_state_changes` row with a unique `(internship_id, revision)` primary key and a unique logical request ID. D1 batches combine the audit row, state mutation and revision update. Concurrent attempts starting from the same revision therefore compete for the same next revision; one can commit and the other fails closed with a revision conflict rather than silently overwriting state.

Once-only authored events also use `PRIMARY KEY (internship_id, event_id)` in `internship_event_firings`, giving D1-backed exactly-once protection across retries and container replacement.

### Task graph

Phase 2 task states are deliberately smaller than the later full workflow:

`locked -> available -> in_progress -> completed`

Trusted internal cancellation is also allowed from `available` or `in_progress`.

Only the deterministic engine may unlock a `locked` task. A task with dependencies remains locked until all dependencies are completed, unless an authored event explicitly performs a validated `unlock_task` or `assign_task` mutation.

The validator rejects self-dependencies, duplicate dependencies, missing tasks and cycles. Topological ordering is deterministic.

Task completion exists only through the trusted HMAC persistence operation for engine/testing integration. There is no learner-facing mark-complete UI and no artifact/review bypass.

### Actor and learner knowledge boundaries

Actor views combine:

- the pinned canonical scenario version;
- the selected actor definition;
- explicit `scenario_actor_knowledge` grants;
- public facts;
- the current runtime fact values;
- reveal state for future-only facts.

An actor does not receive the complete fact table or future event definitions. A `future_only` fact is withheld until an authored transition reveals it.

The learner-safe view contains only facts whose runtime `learner_revealed` flag is true, current task information and events that have already fired. It does not include the hidden answer key, unrevealed future events, actor-private grants or raw assessor/Mentor state.

Future Mentor, assessor, scenario-director and workplace-actor contexts must remain separate views rather than reusing one universal context.

### Event engine

Phase 2 supports six deterministic trigger types:

1. `time_elapsed_days`, evaluated from the Phase 1 server UTC `started_at`;
2. `task_state`;
3. `all_dependencies_completed`;
4. `fact_equals`;
5. `prior_event`;
6. `decision`, which accepts only a validated authored decision and option ID.

Multiple triggers on one event use AND semantics.

Eligible events are ordered deterministically by:

1. priority descending;
2. authored sequence ascending;
3. event ID ascending.

The evaluator applies one event at a time, persists it, then re-evaluates so fact reveals, task changes and prior-event dependencies can form deterministic cascades. The maximum cascade depth is 16. Prior-event graph cycles are rejected during validation, and Phase 2 supports once-only events only. Repeatable events and bounded random variation are explicitly deferred.

Supported typed mutations are:

- `reveal_fact`
- `set_mutable_fact`
- `unlock_task`
- `assign_task`
- `adjust_deadline`
- `record_decision`

Unknown mutation types are rejected. `set_mutable_fact` is rejected for authored immutable facts. Callers cannot submit arbitrary keys to rewrite canonical truth.

### AI authority boundary

Phase 2 makes no live model calls. The scenario validator, initializer, task dependency resolver, actor knowledge resolver, event trigger evaluator and state mutation path are deterministic.

Future AI may receive bounded views and may later propose known event IDs or authored decision options, but it must not own canonical state. The normal state service does not expose the definition-install operation or an arbitrary state-patch operation.

No fields for chain-of-thought, reasoning scratchpads or model-private reasoning are added to the canonical scenario model.

### Demo fixtures

The committed demo/test packs are:

- Internal Audit Intern at fictional Meridian Energy Services;
- Data Analyst Intern at fictional Northstar Analytics Cooperative;
- Software Engineering Intern at fictional Pineforge Software Studio.

They are deliberately small, fictional, `classification: demo`, `qualifying: false`, and remain outside the published qualifying catalog. They exercise different career families, bounded actor knowledge, hidden facts, task dependencies, time/task/fact/prior-event/decision triggers, priority changes and deterministic state mutations.

They do not award competencies, create Passport evidence, grade rubrics, create artifacts, generate messages, produce reports or create completion records.

### Phase 2 tests and release protection

Focused coverage lives in:

- `tutor/tests/test_virtual_internship_scenario_schema.py`
- `tutor/tests/test_virtual_internship_scenario_state.py`
- `tutor/tests/test_virtual_internship_actor_knowledge.py`
- `tutor/tests/test_virtual_internship_task_graph.py`
- `tutor/tests/test_virtual_internship_event_engine.py`

Cloudflare preflight validates the committed packs and protects the migration, schema, engine routes, persistence adapter, demo manifests and test files. The pinned Tutor Docker build also runs the scenario validator before the complete Python regression suite.

### Phase 2 limitations

Deliberately deferred:

- repeatable scenario events;
- bounded seeded random variation;
- Phase 3 workplace-actor or Mentor model calls;
- workplace inbox/chat/UI;
- learner artifact submission and R2 artifact workflow;
- competency evidence and Passport scoring;
- rubric/assessor scoring;
- reports and completion letters;
- final internship completion.

Phase 3 was implemented subsequently through the Phase 3 orchestration layer described below. Phase 4 remains unchecked.


## Phase 3 Implementation Record

Phase 3 implements AI orchestration infrastructure only. It does not implement the Phase 4 workplace UI, Phase 5 artifact workflow, Phase 6 production assessment/scoring, Phase 7 Competency Passport evidence, final completion gates, reports, completion letters, or Kev.

### AI orchestration location and role vocabulary

The common orchestration package is:

`tutor/railway/virtual_internship/ai/`

The common entry point is:

`tutor/railway/virtual_internship/ai/orchestrator.py`

The authoritative role enum is `VirtualInternshipModelRole` in `roles.py` with exactly four roles:

- `actor`
- `mentor`
- `assessor`
- `scenario_director`

All four roles use one common orchestrator and one provider-resolution abstraction. There are no role-specific Gemini, Qwen, NVIDIA, OpenAI, Claude, or other duplicate provider clients.

### Role policies, prompt versions and limits

Phase 3 uses orchestration schema version 1. Actor, Mentor, assessor and director prompt versions are all version 1. Assessor and scenario-director structured-output schemas are version 1.

The deterministic role policies are:

| Role | Streaming | Max output tokens | First-token timeout | Total timeout | Max attempts |
|---|---:|---:|---:|---:|---:|
| actor | yes | 500 | 7 seconds | 25 seconds | 2 |
| mentor | yes | 1,200 | 9 seconds | 40 seconds | 2 |
| assessor | no partial JSON | 1,400 | n/a | 55 seconds | 2 |
| scenario director | no partial JSON | 800 | n/a | 35 seconds | 2 |

A role uses at most two authorized configured candidates. Provider failure or first-token failure may use one fallback. Structured roles may use the second attempt after a provider failure or malformed/schema-invalid first response. There is no unbounded repair loop.

### Existing Murikah provider and model-access reuse

`providers.py` resolves candidates through the existing Tutor runtime:

- `deeptutor.multi_user.model_access.allowed_llm_options()`
- `deeptutor.services.model_selection.runtime.resolve_llm_config_for_selection()`
- `deeptutor.services.llm.factory.stream()`

The requested model is considered only if it is already present in the current account/deployment allowed options. Candidate ordering is deterministic and role-aware: an authorized explicit selection remains first, then the remaining authorized catalog rows are ranked by the role policy (`latency`, `balanced`, or `reasoning`) while preserving catalog order inside each rank. Provider/model duplicates are removed. No unauthorized model can be introduced by role preference.

Phase 3 adds no internship-specific provider API-key environment variables and does not persist credentials. Existing deployment/admin model policy and account grants therefore remain authoritative.

### Role-specific context construction

Role contexts live in:

`tutor/railway/virtual_internship/ai/context.py`

The explicit builders are:

- `build_actor_context(...)`
- `build_mentor_context(...)`
- `build_assessor_context(...)`
- `build_scenario_director_context(...)`

The actor builder begins with the owner-bound Phase 2 `ScenarioStateService.actor_view(...)`. It receives only that actor's Phase 2 knowledge view, selected non-secret actor metadata, the relevant learner-visible task/event context, bounded actor conversation data, and the current learner message. It does not read the raw Phase 2 canonical fact table.

The Mentor builder uses the Phase 2 learner-safe view, relevant learner-visible task information, the requested/recorded assistance level, bounded Mentor-only conversation context, and the learner question. Mentor-private conversation is not passed to workplace actor context.

The Phase 3 assessor is infrastructure only. Its context is restricted to the relevant task, supplied test criteria/evidence, learner-visible permitted scenario facts and the validated assistance level. It does not receive unrelated Mentor history and it writes no competency evidence.

The scenario director receives learner-safe current state plus a reduced list of authored event choices and authored decision options from the exact pinned definition. It does not receive a generic state-patch capability or private workplace/Mentor transcripts.

### Bounded internship conversation context

Persistent internship conversations do not replay an unlimited 90-day transcript. The hard Phase 3 context limit is 14,000 characters with up to six recent turns. `bounded_conversation(...)` reuses `deeptutor.murikah_context_packet.build_context_packet(...)` when the installed Tutor runtime is available. A deterministic recent-turn fallback exists for source-only tests.

Conversation memory is placed inside an untrusted contextual-data envelope. It is never canonical scenario truth. If conversation memory conflicts with D1, Phase 2 canonical state and its bounded views remain authoritative.

### Prompt-injection and role boundaries

Versioned system contracts are stored in `prompts.py`.

Learner text and conversation memory are explicitly treated as untrusted data. They cannot change role, permissions, knowledge scope or state authority. Actor prompts require the model to remain a workplace actor, not become the Murikah Mentor, and to acknowledge unknown information rather than fabricate hidden facts. Mentor prompts require coaching within the allowed support level without revealing hidden truth or completing prohibited learner work.

No prompt asks for chain-of-thought, scratchpad or hidden reasoning.

### Natural-language streaming

Actor and Mentor calls stream visible chunks after a bounded first-token race. If a provider fails before first visible output, one authorized fallback may be attempted. Losing streams are closed. A hard role total deadline also bounds the selected stream.

Learner-visible actor/Mentor text reuses the existing `deeptutor.murikah_visible_text.sanitize_murikah_visible_text` runtime sanitizer. Structured assessor/director JSON is not altered by the visible-text sanitizer; it is parsed and schema-validated instead.

An interrupted stream after visible output is not silently treated as success. The orchestrator returns the role-safe temporary-unavailable message and records a failed invocation.

### Structured assessor output

Strict validation lives in `outputs.py`.

The Phase 3 assessor test schema is version 1 and contains:

- `schema_version`
- `summary`
- `criteria[]`
- `limitations[]`

Each criterion has a known `criterion_id`, a result from `met | partially_met | not_met | not_assessed`, and known supplied `evidence_refs`. Unknown fields, unknown criterion IDs, unknown evidence references, invalid enums, missing required fields and malformed JSON are rejected.

This infrastructure does not create competency evidence, Passport records, midpoint/final reviews, or completion state.

### Scenario-director structured proposals

The director schema is version 1 and accepts only:

- `select_authored_event` for an event ID already present in the pinned authored definition; or
- `choose_authored_option` for a decision/option pair already present in the pinned authored definition.

Unknown fields, events, decisions and options are rejected.

A `choose_authored_option` proposal may enter canonical state only through Phase 2 `record_decision(...)` followed by Phase 2 `evaluate(...)`. Phase 2 has intentionally exposed no force-fire event operation, so `select_authored_event` remains advisory in Phase 3 and actual event eligibility/application remains the deterministic Phase 2 evaluator's authority. Phase 3 does not create a parallel event mutation language.

### Canonical-state protection

Models are never given database write tools, SQL execution, generic fact mutation, task-state mutation or arbitrary scenario-patch operations.

Actor and Mentor output is dialogue/coaching only. Assessor output is a validated infrastructure result only. Director output is an advisory validated proposal only. The only Phase 3 helper that can lead to canonical change calls the existing typed Phase 2 `record_decision` and `evaluate` service methods. Phase 1 ownership, pinned `scenario_version_id`, duration, qualifying status and completion authority are untouched.

### Learner-safe failures

Role-safe failure messages are centralized in `orchestrator.py`:

- actor: `This workplace response is temporarily unavailable. Please try again.`
- Mentor: `The Mentor is temporarily unavailable. Please try again.`
- assessor: `The assessment service is temporarily unavailable. Please try again.`
- scenario director: `The scenario service is temporarily unavailable. Please try again.`

Raw provider HTTP bodies, hostnames, credentials, stack traces and D1 errors are not returned as learner messages.

### AI invocation audit persistence

Migration:

`tutor/cloudflare/migrations/0009_virtual_internship_phase3_ai.sql`

The dedicated `internship_ai_invocations` table is used because Phase 1 `internship_activity` is lifecycle audit and Phase 2 state-change tables are canonical scenario-transition audit. AI invocation telemetry has different semantics and does not belong in either authority.

The table stores bounded metadata including invocation ID, internship/scenario version, role, relevant actor/task/event/decision IDs, provider/model/profile identifiers, prompt/schema versions, context/output hashes, status, TTFT/total latency, retry/fallback counts, normalized error code, Mentor assistance level, and timestamps.

Indexes support internship/time, role/time and actor/time lookup. The HMAC persistence route is `POST /__muri/persist/internships/ai/invocation`. It independently checks active account status and `internship_instances.learner_id` ownership before inserting metadata. No learner-facing audit-browser route is added.

Prompts, raw responses, API keys, bearer headers and chain-of-thought are not persisted.

### Fast Path compatibility

Phase 3 does not modify `accelerate_chat.py`, `murikah_fast_lane.py`, ordinary `/chat` routing, or the existing Fast Path V2 context/provider race. Internship orchestration code is imported only by Virtual Internship callers. It reuses the solved bounded-context and stream-closing principles without loading scenario orchestration on ordinary Tutor turns.

### Phase 3 tests and release protection

Focused tests live in:

- `tutor/tests/test_virtual_internship_ai_roles.py`
- `tutor/tests/test_virtual_internship_actor_ai.py`
- `tutor/tests/test_virtual_internship_mentor_ai.py`
- `tutor/tests/test_virtual_internship_structured_ai.py`
- `tutor/tests/test_virtual_internship_ai_failover.py`
- `tutor/tests/test_virtual_internship_ai_audit.py`

They use fake provider streams and require no live internet or model provider. Coverage includes authorized/unauthorized model resolution, all four role policies, actor/learner knowledge boundaries, Mentor privacy, assistance levels, prompt injection, natural streaming, provider fallback, losing-stream closure, malformed structured output, one-repair maximum, director proposal validation, Phase 2 application boundary, foreign-owner rejection, audit secrecy and all three Phase 2 demo career families.

Cloudflare preflight protects the role vocabulary/policies, context builders, existing provider reuse, timeout/attempt limits, structured validators, migration, HMAC audit route, persistence adapter, tests and this implementation record.

### Phase 3 limitations and deliberately deferred work

Phase 3 deliberately does not add:

- production workplace/inbox/Mentor UI;
- persistent workplace messages, which remain Phase 4 responsibility;
- artifact upload/version/review workflow;
- production rubric scoring or final assessor decisions;
- competency evidence or Competency Passport scoring;
- AI-generated tasks or arbitrary new events;
- repeatable/seeded-random Phase 2 event extensions;
- completion report, letter or credential generation;
- Kev, System One, a decision-model microservice or new model weights.

Phase 4 is implemented through the dedicated workplace UI record below. Real assessment/scoring and Competency Passport evidence remain unimplemented.

## Phase 4 Implementation Record

Status: **implemented for the learner-facing workplace UI only**. Phase 4 consumes the Phase 1 lifecycle contract, the Phase 2 learner-safe scenario state and the Phase 3 actor/Mentor orchestration contract. It does not implement learner artifact submission, production assessment, Competency Passport scoring, final completion, reports, completion letters or a career catalog.

### Learner route and shared shell

The canonical learner route remains `/virtual-internship`. The pinned DeepTutor overlay installs one optional catch-all route at `web/app/(workspace)/virtual-internship/[[...section]]/page.tsx`, backed by one shared `MurikahVirtualInternshipWorkspace` component. The stable learner URLs are:

- `/virtual-internship`
- `/virtual-internship/inbox`
- `/virtual-internship/work`
- `/virtual-internship/company`
- `/virtual-internship/documents`
- `/virtual-internship/meetings`
- `/virtual-internship/mentor`
- `/virtual-internship/activity`

The global Tutor sidebar retains one Virtual Internship entry. Phase 4 adds only secondary workspace navigation inside that feature.

### Server-authoritative read model and security

`tutor/railway/virtual_internship/workspace.py` builds the learner-safe workspace DTO. It derives day/week and lifecycle display from Phase 1 server timestamps, consumes only Phase 2 learner-safe facts/tasks/events, and joins Phase 4 durable threads/reflections. It never returns raw canonical scenario state, hidden actor knowledge, unrevealed documents, future events, completion criteria, assessor state or competency evidence.

The authenticated router is `tutor/railway/murikah_virtual_internship.py`, mounted at `/api/murikah/virtual-internship`. Ownership is resolved from the authenticated member and the persisted internship. Browser-supplied learner/owner IDs are not accepted as authority.

The dashboard and all passive workplace surfaces are deterministic D1/scenario reads. Loading the dashboard, Work, Company, Documents, Meetings or Activity does not call an LLM.

### Learner API and DTO contract

The browser calls only the authenticated application router under `/api/murikah/virtual-internship`:

- `GET /workspace` for the aggregated learner-safe workplace read model;
- `POST /start` for the existing Phase 1 start flow using safe published start options;
- `GET /threads/{thread_id}` for an owned workplace or Mentor conversation;
- `GET /documents/{document_id}` for one currently learner-visible scenario source document;
- `POST /reflections` for the learner-owned current-period reflection;
- `POST /actor/messages/stream` for workplace actor interaction through Phase 3;
- `POST /mentor/messages/stream` for Murikah Mentor interaction through Phase 3.

The frontend contract is explicit rather than raw D1 rows. `MurikahVirtualInternshipWorkspace.tsx.txt` defines `InternshipWorkspaceSummary`, `InternshipTaskSummary`, `InternshipPerson`, `InternshipThread`, `InternshipMessage`, `InternshipCompanyView`, `InternshipDocument`, `InternshipMeeting`, `InternshipTimelineItem` and `InternshipReflection`. Server timestamps remain authoritative Unix seconds and are formatted locally only for display.

The Overview displays the simulated company and role, active/stopped lifecycle state, scenario version, server-derived internship day and week, workload band, active work count, next real deadline, next real meeting when present, recent workplace threads and recent learner-visible activity. It deliberately does not expose a synthetic completion percentage, score or competency level.

### Durable Phase 4 records

Migration `0010_virtual_internship_phase4_workspace.sql` adds only the UI state Phase 4 genuinely requires:

- `internship_message_threads`
- `internship_messages`
- `internship_reflections`

Messages have request-level idempotency. Mentor and workplace threads remain logically separate. Reflections are owned through the internship. Meetings continue to come from learner-visible Phase 2 scenario events, so Phase 4 does not duplicate authored meeting definitions.

### Workplace inbox and Murikah Mentor

Workplace actor messages and Murikah Mentor messages call the existing Phase 3 `VirtualInternshipAIOrchestrator` on the server. React never calls a model provider directly. Learner messages are persisted before generation; final learner-visible actor/Mentor text is persisted after streaming. Retrying with the same request ID does not duplicate the learner message. Provider/model failures are limited to the attempted interaction and do not break the rest of the workspace.

The Mentor is a distinct surface and thread kind. It can explain, coach and help plan within the permitted assistance metadata, but Phase 4 provides no task-completion shortcut.

### Work, documents, meetings and activity

The Work queue renders only task state returned by the learner-safe read model and is read-only for Phase 4. It provides no Submit, Upload, Mark complete, Approve or Pass task control.

Documents are learner-visible scenario source material only. Detailed content is fetched through the owned document endpoint. Phase 4 does not accept learner work artifacts.

Meetings are text-based and come only from learner-visible scenario state. The timeline normalizes learner-facing internship events, messages, meetings/reflections and stopped state, ordered by server timestamps with a stable secondary key.

### Reflections

The Activity surface includes a durable weekly reflection interface. Reflections are learner-authored records and are not scored, assessed or converted to competency evidence in Phase 4.

### Guest, stopped and failure states

Guests receive only a polished product preview and the existing account sign-in/sign-up path. They do not receive workplace data, actor access, Mentor internship context or reflection history.

A stopped internship remains historical and read-only. It is never relabelled as completed. Actor sends, Mentor sends and new reflection writes are disabled while existing state remains reviewable.

Each surface has intentional loading, empty and learner-safe error states. No SQL/provider/Cloudflare exception is intentionally rendered to the learner.

### Responsive and accessibility contract

The workplace uses cards/lists rather than desktop-only tables, horizontally scrollable secondary navigation, a mobile inbox list-to-thread pattern and responsive company/task layouts. It is designed for 320, 375, 768, 1024 and 1440 pixel widths without requiring hover-only interaction.

The UI uses semantic headings, navigation landmarks, links for navigation, buttons for actions, labelled form fields, visible focus treatment and `aria-current` for the active workspace section. Phase 4 user-visible strings follow the existing Murikah no-em-dash contract.

### Phase 4 regression coverage

Backend coverage remains in `tutor/tests/test_virtual_internship_phase4_backend.py`, including learner isolation, hidden-state filtering, deterministic/model-free dashboard reads, stopped state, durable idempotency and secure document visibility.

Frontend integration coverage is in `tutor/tests/virtual-internship-workspace.spec.tsx.txt`, including dashboard truthfulness, stable deep links and active navigation semantics, Work detail without Phase 5 controls, learner-safe company rendering, secure document loading, meeting and empty states, actor streaming, Mentor separation/streaming, reflection persistence, stopped read-only behavior, guest/no-internship states, narrow-screen access to core controls and learner-safe loading/error behavior.

The Tutor Docker build restores the overlay component into the pinned DeepTutor checkout and runs this integration test alongside the existing Tutor integration suite before the production Next.js build.

### Regression, preflight and known Phase 4 limitations

Phase 1 ownership, one-active-internship, duration, pinned scenario version, stop behavior and object-key contracts remain authoritative and unchanged. Phase 2 remains authoritative for canonical scenario truth, actor knowledge, task/event graphs and learner visibility. Phase 3 remains authoritative for model roles, bounded context, provider reuse, timeouts/fallback, structured output, safe failures and model audit metadata.

`tutor/cloudflare/preflight.py` protects the shared workspace source, stable route labels, authenticated Phase 4 router endpoints, frontend integration test, completed Phase 4 checklist, this implementation record and the subsequent-workplace-UI requirement. `tutor/railway/validate_guest_overlay.py` protects the installed workspace route and guest/auth navigation invariants in the pinned DeepTutor overlay.

Known Phase 4 limitations are intentional phase boundaries. Meetings are rendered only when Phase 2 exposes a learner-visible authored meeting/check-in event; the current demo pack may therefore show the deliberate empty state. Phase 4 itself did not implement learner artifact drafting/upload/submission/review; Phase 5 now extends that same Work surface without changing the Phase 4 shell. Rubric assessment, competency evidence, Competency Passport UI, final completion/certificate/report/letter flow, browser push/email notifications and global workplace search remain outside Phase 4. Reflection text is stored but is not silently model-assessed.

## Phase 5 Implementation Record

Status: **implemented for the work-artifact workflow only**. Phase 5 adds real learner work products and workflow review to the existing Phase 4 Work surface while preserving the Phase 1 ownership/R2 contract, Phase 2 task/event state machine and Phase 3 model orchestration boundary. It does not implement Phase 6 scoring or competency assessment, Phase 7 Competency Passport evidence, Phase 8 internship completion, a performance report or a completion letter.

### Durable model and lineage

Migration `0011_virtual_internship_phase5_artifacts.sql` adds:

- `internship_task_acknowledgements`;
- `internship_artifacts`;
- `internship_artifact_versions`;
- `internship_artifact_submissions`;
- `internship_artifact_reviews`;
- `internship_artifact_activity`.

The canonical lineage is:

`learner -> internship -> pinned scenario version -> task -> artifact -> artifact version -> submission -> review`

A task remains the authored Phase 2 assignment. An artifact is one logical learner work product for an authored deliverable slot. A version is one immutable saved representation. A submission explicitly references one exact version. A review explicitly references one exact submission. Phase 5 never collapses those records into one mutable row.

A task may require multiple authored deliverables. `UNIQUE (internship_id, task_id, deliverable_type)` prevents duplicate logical artifacts for one deliverable slot while allowing one task to have several distinct work products. Version and submission numbers are monotonically increasing per artifact and protected by database uniqueness plus retry-safe server logic.

### Assignment acknowledgement and Phase 2 integration

Opening an assignment does not acknowledge it. The learner uses the explicit `Acknowledge assignment` action. The application first invokes the existing Phase 2 typed transition from `available` to `in_progress`, then persists acknowledgement metadata and learner-visible activity. Repeated acknowledgement is idempotent and does not duplicate activity.

Phase 5 never patches `internship_tasks.status` directly. When the final required deliverable is accepted, the server verifies all authored `deliverable_types` are satisfied and calls `ScenarioStateService.transition_task(..., "completed")`. It then reuses the Phase 2 deterministic event evaluation path. Task completion is not internship completion.

### Artifact creation, drafting and upload

The learner creates work only for an owned active internship, an eligible Phase 2 task and a deliverable type declared by the task definition. Text-oriented deliverables use a lightweight plain-text/Markdown drafting surface. Each explicit Save draft creates a new immutable version. Phase 5 does not autosave on each keystroke.

File versions accept a bounded allowlist including PDF, DOCX, XLSX, CSV, PPTX, TXT, Markdown, common raster images, JSON/notebook data and common source-code text. The current limits are one file per version, 10 MiB per file/version request, 100 versions per logical artifact and 120,000 characters for a text draft. Dangerous executable formats are rejected. Code, notebooks, HTML and SVG are data only and are never executed; active learner HTML/SVG is not injected into the Tutor DOM.

The Worker normalizes the extension and declared MIME type, rejects dangerous or contradictory types, computes SHA-256 and authoritative byte size server-side, and generates the final R2 key. The browser cannot supply the final object key or an owner identity.

### Private R2 ownership and integrity

D1 remains the ownership/control plane and private `TUTOR_FILES` R2 remains the object plane. Every artifact version is registered through the existing global `tutor_objects` ownership authority with:

- `owner_kind = user`;
- `owner_id = authenticated learner actor ID`;
- `object_type = artifact-version`;
- the canonical generated object key;
- server-computed SHA-256;
- byte size and normalized content type.

The canonical object key is:

`users/<learner-id>/virtual-internships/<internship-id>/artifact-version/<artifact-version-id>`

Original filenames remain metadata and are sanitized for `Content-Disposition`; they are never appended to the R2 key. R2 is not public and no `r2.dev` URL is used.

D1 and R2 are finalized with compensation. If R2 write succeeds but D1 ownership/version finalization fails, the known Phase 5 object is deleted rather than silently left unregistered. The owner-scoped `/internships/artifacts/integrity` bridge route deterministically reconciles registered versions, missing R2 objects, byte-size mismatches, full SHA-256 mismatches and unregistered objects under the exact Phase 5 learner/internship prefix without automatically deleting uncertain objects.

### Secure retrieval

Artifact history responses expose opaque artifact/version identifiers and learner-safe metadata, not raw R2 keys. A download re-authenticates the member, verifies internship ownership, verifies the version belongs to the artifact/internship, verifies the matching `tutor_objects` owner, reads the private R2 object and checks expected size. Downloads use safe `Content-Disposition`, `private, no-store` cache policy and `nosniff`.

Previous versions remain retrievable by their owner after later saves. Submitted and accepted versions are immutable. Phase 5 deliberately adds no destructive artifact-delete endpoint.

### Authenticated API and persistence adapter

The browser uses only the normal authenticated application router under `/api/murikah/virtual-internship`. Phase 5 adds typed actions rather than a generic status patch:

- `POST /tasks/{task_id}/acknowledge`;
- `GET /artifacts?internship_id=...`;
- `POST /artifacts`;
- `GET /artifacts/{artifact_id}?internship_id=...`;
- `POST /artifacts/{artifact_id}/versions/text`;
- `POST /artifacts/{artifact_id}/versions/upload?internship_id=...`;
- `GET /artifacts/{artifact_id}/versions/{version_id}/text?internship_id=...`;
- `GET /artifacts/{artifact_id}/versions/{version_id}/download?internship_id=...`;
- `POST /artifacts/{artifact_id}/submit`;
- `POST /submissions/{submission_id}/review` to retry the server-controlled simulated-supervisor workflow review.

The upload endpoint consumes one bounded raw file request and therefore does not introduce a new multipart package dependency. Filename, content type and request ID are metadata headers on the same-origin authenticated application request; the application derives the member identity and then forwards the bytes through the protected HMAC persistence bridge.

`murikah_persistence.py` adds owner-bound methods for artifact summary/history, assignment acknowledgement, artifact creation, text save, file upload, submission, review start/material/persistence, secure download/text retrieval, task-completed activity and the read-only artifact integrity check. None accepts an arbitrary owner parameter from browser state.

### Phase 5 state machines

Artifact workflow state is explicit:

`draft -> submitted -> changes_requested -> submitted -> accepted`

`accepted` is terminal in Phase 5. A reviewed/submitted version is not edited in place; a revision creates another immutable version.

Submission workflow state is explicit:

`submitted -> under_review -> changes_requested | accepted`

Retries with the same logical request ID are idempotent. Distinct later submissions receive monotonically increasing submission numbers and preserve prior submission rows.

"Completion" in the Phase 5 checklist means task/work-artifact workflow completion after all authored deliverables are accepted. It does **not** mean internship completion; final internship completion remains a later phase.

### Submission, revision and review history

Save draft and Submit for review are separate learner actions. Submission is explicit and immutable. The UI shows which version is being submitted and confirms that it will remain in submission history.

If changes are requested, the prior submitted version remains read-only. The learner creates a new version, optionally linked to the prior review, and creates a new submission attempt. Submission 1 is never overwritten by Submission 2. The Work surface shows version history, submission history, reviewer feedback and requested changes as responsive stacked cards rather than a desktop-only table.

### Simulated supervisor workflow review

Supervisor workflow review is Phase 5 workflow control, not Phase 6 assessment. The authorized reviewer is derived server-side from the authored task's assigned supervisor relationship. The learner cannot choose an arbitrary reviewer and has no public `accept submission` status endpoint.

Automated review reuses the existing Phase 3 `VirtualInternshipAIOrchestrator`, provider/model configuration, bounded timeouts/fallback and model-invocation audit path. It uses a dedicated strict workflow schema with only:

- `schema_version`;
- `decision = accepted | changes_requested`;
- `feedback`;
- `requested_changes`.

Unknown fields are rejected. The Phase 5 reviewer cannot return a score, grade, competency level, evidence strength, final rating, internship pass result or Competency Passport evidence. Only validated learner-visible feedback, requested changes, workflow decision and `model_invocation_id` are persisted; chain-of-thought is never stored.

Supervisor context is minimized to the learner-safe reviewer identity, relevant task brief, one submitted artifact representation and bounded prior workflow feedback. It does not receive the full internship database, unrelated artifacts, full Mentor history or other learners.

The repository currently has no safe PDF/DOCX/XLSX extraction pipeline. Those formats are therefore stored and downloaded securely, but Phase 5 does not invent a parser or pretend to review their contents. Automated review fails closed for unsupported binary representations: the submission remains submitted/under review, no accepted decision is created and no task completion occurs. Text-oriented artifacts are bounded before model use.

### Work UI, activity, accessibility and mobile

Phase 5 extends the existing `Work` route. It does not create Work V2, Assignment Center or another competing navigation surface. Task detail now shows assignment/work status, expected deliverables, acknowledgement, current work product, latest version, submission state, simulated-supervisor feedback and version/submission history.

Meaningful activity is durable and learner-visible: assignment acknowledged, work product created, version saved, submitted, resubmitted, changes requested, accepted and task completed. Internal D1/R2 implementation details are not shown as workplace activity.

Primary actions use semantic buttons and labelled controls. File upload has a normal file chooser rather than drag-and-drop-only behavior. Version history uses stacked responsive cards so the workflow remains usable on narrow mobile widths, including 320, 375 and 430 pixels. Submitted versions cannot be edited; revisions create new versions.

### Guest, stopped and failure behavior

Guests remain on the existing preview/auth flow and cannot create artifacts, upload work, submit, retrieve member artifacts or receive supervisor review. A stopped internship keeps its owned artifacts, historical versions, submissions, reviews and downloads available, but all new Phase 5 writes are read-only.

R2/storage/integrity failures fail closed. A missing R2 object does not return an empty file. Ownership mismatches do not self-correct from browser input. AI timeout/provider/schema failure leaves the submission under review and returns learner-safe review-unavailable text rather than inventing a decision.

### Phase 5 verification coverage

Backend coverage is in `tutor/tests/test_virtual_internship_phase5_artifacts.py`. It protects the strict workflow-review schema, absence of Phase 6/7 scoring fields, workspace artifact state, immutable version/submission lineage, ownership/integrity controls, typed learner actions, upload bounds and the no-direct-task-status-patch rule.

The existing frontend integration suite `tutor/tests/virtual-internship-workspace.spec.tsx.txt` is extended to protect deliberate acknowledgement and the Phase 5 Work surface while retaining Phase 4 dashboard, inbox, company, documents, meetings, Mentor, activity, guest and stopped-state regressions.

Cloudflare preflight protects the Phase 5 migration, private-storage/integrity markers, strict workflow-review contract, authenticated API actions and Work UI controls. The Docker production-image build runs the full Python unit-test discovery and the Virtual Internship frontend integration suite before building the pinned Next.js Tutor image.

Intentional Phase 5 boundaries remain: no rubric engine, competency score, competency level, Competency Evidence Record, Competency Passport entry, internship completion gate, performance report or completion letter is created here.

## SUBSEQUENT ARTIFACT DEVELOPMENT REQUIREMENT

Future assessment, Competency Passport, reporting and completion work must treat the Phase 5 artifact lineage as immutable historical evidence. Future phases must preserve artifact IDs, immutable artifact versions, immutable submission snapshots, review history, SHA-256 integrity metadata and private R2 ownership through `tutor_objects`. Do not overwrite a submitted version, repoint an old submission to a newer version, replace `tutor_objects` with a second ownership truth, publish R2 objects, authorize with raw object keys, expose another learner's artifact, or let the browser patch workflow/task status.

Phase 6 must build assessment on top of the Phase 5 task/artifact/version/submission/review lineage rather than create a second work-product system. Phase 6/7 may reference accepted artifact versions and their assistance/review lineage, but any score, competency judgment or Passport evidence must be a separate later-phase record that references actual artifact/submission evidence. AI-generated reviewer reasoning is not evidence by itself. A Phase 5 `accepted` decision means only that the work product is ready to move forward in the simulated workflow.

Later phases must continue to use authenticated actor ownership, the pinned scenario version, Phase 2 typed task transitions/events, Phase 3 provider/orchestration and bounded-context rules, private R2, server-computed integrity metadata, learner-safe errors and retry-safe request IDs.

## Phase 6 Implementation Record

**Status:** verified. The Phase 6 release blocker in `test_virtual_internship_assessment_fairness.py` was corrected and the dedicated **Build Murikah Tutor image** workflow run 35973202713 passed on the repair branch before this checklist was closed. That verification included Tutor deployment preflight, Cloudflare migration preflight, Worker dry-run/check, 8 frontend integration test files, 6 committed scenario packs, 271 packaged Tutor Python tests, and the pinned production Tutor image build. The final documentation head must pass the same dedicated workflow before merge.

### Persistence, rubric authority and calculation

Phase 6 uses `tutor/cloudflare/migrations/0012_virtual_internship_phase6_assessment.sql`. It adds `internship_assessments`, `internship_assessment_criteria`, `internship_assistance_events` and `internship_performance_reviews`, with owner-bound indexed reads and immutable completed/finalized history.

Rubrics remain authored inside the pinned Phase 2 scenario-version task definition. Phase 6 does not create a second rubric authority. `tutor/railway/virtual_internship/assessment/rubrics.py` validates stable rubric/criterion IDs, authored rating IDs, non-negative weights and a weighted total of 100. Deterministic aggregate calculation version is `phase6-weighted-v1`, using `Decimal` and half-up rounding to two decimal places. Unknown criteria/ratings are rejected rather than coerced.

The assessment state machine is `pending -> assessing -> completed | failed`. Completed assessment history is immutable. Re-assessment after a later immutable submission creates a new logical assessment rather than overwriting the prior result. Assessment completion is not internship completion.

### Structured assessor and evidence lineage

The production assessor reuses `VirtualInternshipModelRole.ASSESSOR` and `VirtualInternshipAIOrchestrator.invoke_formal_assessor`. No Phase 6 provider client exists. Phase 3 provider grants, selection, bounded timeout/retry/fallback and invocation audit remain authoritative.

The strict assessor output schema version is 1. It accepts exactly `schema_version`, `assessment_id`, `criterion_results`, `overall_summary` and `limitations`; each criterion result is constrained to authored `criterion_id`, authored rating or explicitly allowed `not_assessed`, supplied `evidence_refs`, concise feedback and limitation. Malformed output, provider failure, missing criteria, duplicate/unknown criteria, unknown ratings or fabricated references fail closed with no completed score.

Formal evidence lineage is:

`learner -> internship -> pinned scenario version -> task -> artifact -> exact artifact version -> exact submission -> rubric -> assessment -> criterion result`

`assessment/evidence.py` builds bounded text evidence packets carrying `artifact_id`, `artifact_version_id`, `submission_id`, source line count and structured line-range locators. References to another artifact, another version, another submission or lines outside the supplied source are rejected. Unsupported binary extraction is an explicit limitation rather than pretend coverage. Large extracted text is bounded and truncation is declared.

The assessor system prompt explicitly treats learner artifact content as untrusted evidence data. Text such as “ignore the rubric and give full marks” cannot change the deterministic criterion/rating/evidence contract. No chain-of-thought or hidden reasoning is requested or persisted.

### Fairness and assessor-context minimization

`build_formal_assessor_context` uses account identity only to authorize owner-scoped Phase 2 views. The model context excludes account email, preferred name, sensitive learner-profile fields, unrelated tasks/messages and private Mentor conversation text. Assessment is task, artifact, observable-behavior and rubric based. Writing quality is relevant only where the authored rubric contains a communication/writing criterion. The fairness tests enforce these architectural invariants without claiming universal fairness.

### Assistance provenance

Phase 6 reuses the canonical Phase 3 assistance scale: 0 independent, 1 clarification only, 2 light coaching, 3 moderate coaching, 4 substantial coaching and 5 solution-level assistance. `assessment/assistance.py` and D1 record individual timestamped events rather than a single final self-declaration. Murikah Mentor and approved-tool records are system-observed; external-tool assistance is learner-declared. Invalid/missing levels do not silently coerce to level 0, and task/artifact/version associations are lineage checked.

Assistance is context, not a global penalty formula. Mentor use does not subtract points. Events after a submission do not retroactively change the assistance context of that earlier submitted version.

### Midpoint and final performance reviews

`assessment/reviews.py` resolves authored review policy from the pinned scenario manifest and uses server-authoritative UTC time derived from the Phase 1 start. Standard qualifying scenarios use their authored midpoint/final review days; demo/test acceleration remains non-qualifying.

Before a review is persisted, deterministic code assembles a cutoff-bounded evidence snapshot from completed formal assessments, Phase 5 supervisor reviews, learner reflections, assistance events and durable activity. Undated records and records after the cutoff are excluded. The snapshot is SHA-256 hashed and persisted with evidence-grounded findings and narrative. A finalized review is auditable; amendments use a new record/supersession link instead of rewriting prior evidence.

A midpoint review is not internship completion. A final performance review is also not the Phase 8 completion gate or Phase 9 Internship Performance Report. Neither review creates Competency Passport evidence.

### Workplace dynamics and ethics

`tutor/railway/virtual_internship/dynamics/library.py` contains a versioned, career-neutral initial workplace-dynamics library covering competing priorities, ownership disagreement, management challenge, deadline/scope pressure, resource constraints, incomplete handover, credit/recognition tension, stakeholder resistance, ambiguous instruction and cross-team coordination. Templates compile into the existing Phase 2 authored event/decision machinery; AI may animate dialogue but does not gain authority to invent irreversible consequences.

`tutor/railway/virtual_internship/dynamics/ethics.py` contains authored professional-judgment events for conflict of interest, pressure to soften a material issue, confidentiality/privacy, inappropriate data access, control override, questionable reporting, policy/compliance conflict, career-appropriate safety escalation and client/stakeholder instruction conflicts. Only authored response options are accepted and consequences remain `phase2_authored_only`.

The libraries deliberately exclude humiliation, discriminatory entertainment, sexual-harassment simulation directed at the learner, violence threats and AI-authored termination.

### Learner-facing UI integration

Phase 6 extends the existing Phase 4/5 Virtual Internship workspace rather than adding a second application or navigation system. Formally assessed submissions show the exact assessed version, criterion results, evidence references, feedback and limitations. Midpoint/final review material is integrated into the existing review/activity surfaces. No Competency Passport level, certificate, completion letter or qualifying-completion action is exposed.

### Verification and release protection

Focused backend coverage is in:
- `tutor/tests/test_virtual_internship_rubrics.py`
- `tutor/tests/test_virtual_internship_assessor.py`
- `tutor/tests/test_virtual_internship_assessment_evidence.py`
- `tutor/tests/test_virtual_internship_assistance.py`
- `tutor/tests/test_virtual_internship_performance_reviews.py`
- `tutor/tests/test_virtual_internship_workplace_dynamics.py`
- `tutor/tests/test_virtual_internship_ethics.py`
- `tutor/tests/test_virtual_internship_assessment_fairness.py`

The production Dockerfile copies the full `virtual_internship` package, committed scenario packs, Cloudflare source/migrations and test suite into the final build path; it runs the scenario validator and full Tutor Python regression suite before the final runtime image is accepted. Cloudflare preflight protects Phase 6 migration/table markers, deterministic assessment modules, assessor reuse, assistance validation, dynamics/ethics libraries, focused tests, documentation and phase boundaries. Release-gate verification on workflow run 35973202713 recorded: Cloudflare migration preflight PASS, Worker dry-run PASS, frontend integration 8/8 files PASS, scenario validation PASS for 6 packs, packaged Python regressions 271/271 PASS, and pinned Tutor production image build PASS.

Intentional boundaries remain explicit: **Phase 7 Competency Passport remains unimplemented. Phase 8 internship completion remains unimplemented. Phase 9 reports and letters remain unimplemented.** Phase 6 creates traceable assessment evidence for later phases but does not aggregate competencies, transition the internship to completed, generate credentials, issue a report or create verification IDs.


## Phase 7 Implementation Record

**Status:** implementation present on the Phase 7 branch; the Phase 7 checklist remains intentionally unchecked until focused tests, both preflights, Worker dry-run and the production Tutor image gate pass on the final head.

### Persistence, competency authority and level framework

Phase 7 uses `tutor/cloudflare/migrations/0013_virtual_internship_phase7_passport.sql`. D1 is the canonical competency-definition authority. Definitions are immutable versioned rows keyed by `competency_id + definition_version`; the migration seeds the 11 competency IDs already authored by the published Phase 2 v2 task packs rather than inventing a second namespace. `competency_assessment_mappings` explicitly maps each published v2 rubric criterion to its task-authored competency. Mapping is authored and versioned; assessor prose is never parsed to guess competency meaning.

The canonical level framework is `phase7-levels-v1`: **Emerging**, **Developing**, **Applied with support**, **Independent**, **Advanced**. Emerging requires demonstrated evidence rather than task exposure. Developing requires repeated qualifying contribution. Applied with support represents credible application where material assistance remains part of context. Independent requires qualifying low-assistance evidence. Advanced requires repeated Independent evidence plus distinct task and transfer contexts; one high-scoring artifact can never award Advanced.

### Competency Evidence Record and exact lineage

`competency_evidence` is immutable. Each evidence row preserves:
`learner -> internship -> scenario version -> task -> artifact -> exact artifact version -> exact submission -> Phase 6 assessment -> exact assessment criterion -> authored competency mapping -> Competency Evidence Record`.

Evidence IDs are opaque. The uniqueness key `learner + assessment + criterion + competency + definition version + evidence ruleset` makes retries idempotent. Corrections use immutable `competency_evidence_adjustments` revocation/supersession records rather than rewriting history. Evidence never stores chain-of-thought, model confidence as competence, hidden scenario truth or artifact bytes.

Completed Phase 6 assessments are the only initial evidence source. A `not_yet` criterion is preserved as `not_demonstrated` contradictory evidence, but does not award Emerging. `developing` contributes Developing. `meets/exceeds` contributes Independent when the maximum relevant pre-submission assistance is 0–1, otherwise Applied with support. This candidate is one evidence contribution, not the final Passport level.

### Evidence strength, assistance and revision context

Evidence-strength ruleset `phase7-evidence-strength-v1` is deterministic and separate from competency level. Exact completed assessment lineage plus specific evidence references produces Supporting evidence; the same evidence with low-assistance context is Strong. Broken lineage or missing required references fails closed. Strength never uses model confidence.

Phase 7 reuses Phase 6 assistance events and the canonical 0–5 scale. System-observed and learner-declared assistance counts remain distinguishable. Assistance is context, not a score penalty. Only events at or before the exact submission timestamp are considered; later Mentor help cannot retroactively affect an earlier submitted version. Artifact version number, submission number and revision count are preserved without treating revision itself as weakness.

### Aggregation, contradictory evidence, transfer and trend

Runtime Passport aggregation is the D1 Worker service in `tutor/cloudflare/src/virtual_internship_phase7.ts`, ruleset `phase7-passport-aggregation-v1`. It does not call an LLM and does not average rubric percentages. It evaluates each competency's versioned evidence requirements over immutable evidence, tracking evidence count, Independent/assisted contribution count, distinct internship+task contexts, structured transfer contexts, evidence-strength distribution, internship count and chronology.

Repeated criteria from one task remain one task context and cannot fake transfer. Transfer context uses structured authored tags (`career_family`, `role_family`, `scenario_pack_id`, `task_category`, `domain`, `work_context`), never raw scenario title or assessor prose. Evidence from multiple internships aggregates only inside the same compatible competency definition version. Historical evidence always retains its original internship and definition version.

Contradictory evidence is preserved. The versioned definition recency policy uses the two most recent strong contributions: one recent strong `not_demonstrated` contribution caps a previously higher aggregate at Developing; two in the configured window cap it at Emerging. This is an explicit deterministic conflict rule, not naive highest-ever, latest-only or averaging. No evidence expires because the initial definitions configure no expiry. Trend requires at least three chronological evidence records and returns `improving`, `stable`, `mixed` or `insufficient_evidence`.

### Materialized Passport, rebuild and reconciliation

`competency_passports` is a rebuildable learner read model; `competency_evidence` remains the authority. `competency_passport_history` records actual aggregate level changes with previous/new level, explanation and ruleset. `competency_derivation_status` makes the Phase 6 -> Phase 7 boundary recoverable. Formal assessment completion attempts reconciliation, but a temporary Phase 7 failure never rewrites or invalidates the completed Phase 6 assessment. Passport reads reconcile missing completed assessments idempotently. The full rebuild path recalculates materialized summaries from durable evidence with zero model calls.

### Passport UI, drill-down and export

The shared Virtual Internship workspace now has a real `/virtual-internship/passport` section. It shows competency name, current demonstrated level, evidence strength, evidence count, Independent/assisted context, distinct task/context/internship counts, deterministic trend, last demonstrated date and evidence still missing for the next level. It intentionally has no overall employability percentage, learner ranking, badges, XP, streaks or job-readiness claim.

Evidence drill-down shows the source internship/scenario, task, artifact title/type, exact artifact version, exact submission, Phase 6 assessment and criterion, evidence contribution, evidence strength, assistance context, assessment date, limitations and a learner-owned link back to Work. Raw internal JSON rules, hidden scenario facts, provider secrets and chain-of-thought are not exposed.

`POST /api/murikah/virtual-internship/passport/export` is an explicit learner-controlled JSON export. It contains definition/ruleset versions, current competency summaries and stable evidence references with a Virtual Internship simulation disclosure. It does not embed private artifact contents, publish a public profile, create an employer verification ID, imply employment, or issue a completion credential.

### Ownership, performance and phase boundary

All learner-facing Passport endpoints derive the owner from the authenticated Tutor session. Guests cannot create evidence, accumulate a Passport, read member evidence or export a Passport. The browser has no route to set competency level, evidence strength, assistance level, evidence lineage or aggregation rules. Passport reads use D1 summaries/metadata and never fetch R2 artifact bytes or invoke a model.

Focused Phase 7 tests cover definitions/versioning, evidence derivation/immutability/idempotency, evidence strength, assistance, aggregation, contradictory evidence, transfer, ownership, export, D1 migration/restart and Passport UI/drill-down. Cloudflare preflight protects the Phase 7 migration, Worker service, ruleset versions, UI, tests and this record.

**Phase 8 internship completion remains unimplemented. Phase 9 performance reports, completion letters, certificates and public verification IDs remain unimplemented.**

## SUBSEQUENT COMPETENCY PASSPORT DEVELOPMENT REQUIREMENT

Future phases must preserve immutable Competency Evidence Records; exact Phase 5 artifact/version/submission and Phase 6 assessment/criterion lineage; competency-definition versions; evidence-strength ruleset versions; Passport aggregation ruleset versions; structured assistance/transfer context; and learner ownership isolation. Future code must not create competency evidence from model prose, model confidence, browser-supplied levels or unsupported external certificates.

Phase 8 completion may consume Passport evidence gates but must not rewrite Passport evidence or make the Passport itself a completion credential. Phase 9 reports and letters must read the existing Passport/evidence results rather than independently re-assessing artifacts. Any future competency semantic change requires an explicit new definition version and compatibility/migration declaration; historical evidence keeps the original definition version.

## SUBSEQUENT ASSESSMENT DEVELOPMENT REQUIREMENT

Future assessment/reporting/completion phases must reuse Phase 6 assessment records rather than re-assessing artifacts ad hoc. Phase 7 competency evidence must reference the exact Phase 6 assessment, task, artifact version and submission lineage. Preserve the authored rubric version/hash, deterministic calculation version, structured criterion results, assistance provenance and evidence references.

Future phases must not turn raw assessor-model output directly into competency state. Any Phase 7 competency/evidence-strength rule must be a separate deterministic authority over persisted Phase 6 evidence. Preserve owner isolation, assessor-context minimization, prompt-injection boundaries and the distinction between Phase 5 workflow review and Phase 6 formal assessment.

## SUBSEQUENT WORKPLACE UI REQUIREMENT

Future Virtual Internship UI work must reuse the Phase 4 workspace shell and learner-safe APIs. It must never fetch raw canonical scenario state or expose hidden actor, fact or event data to the browser.

Future workplace UI changes must reuse Phase 3 AI orchestration rather than calling model providers directly from React. They must also reuse the shared preferred-name contract and visible-text sanitization, preserve mobile and responsive behavior and accessibility, preserve message and thread ownership, and preserve the separation between Murikah Mentor conversations and workplace actor conversations.

Phase 5 must extend the existing Work surface rather than build a second assignment UI.

## SUBSEQUENT AI ORCHESTRATION REQUIREMENT

Future Virtual Internship AI development must use the Phase 3 orchestrator and role contracts. Workplace UI must not call model providers directly. Future work must preserve current model grants, use Phase 2 actor/learner bounded views, avoid raw full-canonical-state actor prompts, keep conversation context bounded, reuse prompt/schema versions and learner-safe errors, retain invocation audit metadata, preserve prompt-injection boundaries, close losing/expired streams, and never allow model output to patch canonical scenario state.

Do not create duplicate provider/fallback logic or a second Virtual Internship model configuration system. Canonical changes must continue through typed deterministic Phase 2 operations. Ordinary Tutor Fast Path V2 must remain independent.

## SUBSEQUENT SCENARIO DEVELOPMENT REQUIREMENT

Before Phase 3 or any later Virtual Internship feature reads or mutates simulation truth, read both the **Phase 1 Implementation Record** and **Phase 2 Implementation Record** in full.

Reuse:

- the Phase 1 authenticated ownership, pinned scenario version, duration and R2 contracts;
- the Phase 2 schema/version hash, immutable snapshot, state revision, task/event and bounded-view contracts;
- `ScenarioStateService` and its typed persistence operations for canonical state.

Do not create a second scenario-state store, a second learner ownership field, an unvalidated actor prompt as hidden truth, a generic AI state patch, or a UI that reads raw canonical facts.

## Tutor AI Runtime / Fast-Path Compatibility

Virtual Internship Phase 1 does not modify ordinary Tutor Fast Path V2. Future internship AI must preserve the solved ordinary-chat latency architecture where applicable.

The current Tutor approach uses:

- bounded compact context packets;
- recent verbatim turns plus structured older-memory summary;
- prepared next-turn context;
- provider affinity;
- rapid provider hedging;
- explicit current-turn fast/deep lane selection;
- bounded first-token, stream-idle and shared turn deadlines;
- one automatic continuation;
- partial-answer preservation;
- model/provider abstraction;
- `MURIKAH_LATENCY` instrumentation.

### SUBSEQUENT VIRTUAL INTERNSHIP AI DEVELOPMENT REQUIREMENT

Before implementing workplace actors, Mentor conversations, simulated supervisors, inbox conversations, scenario-director AI or other persistent internship conversations, read:

- `tutor/docs/FOLLOWUP_FAST_PATH_V2_AUDIT.md`
- `tutor/railway/accelerate_chat.py`
- `tutor/railway/murikah_context_packet.py`
- `tutor/railway/murikah_fast_lane.py`

Future workplace actors, Mentor chat, supervisor conversations, inbox conversations and scenario-director calls must **not**:

- replay unlimited internship conversation history to models;
- create an independent unbounded transcript/chat-history architecture;
- bypass Murikah's provider/model abstraction;
- inherit stale prior-turn metadata that unexpectedly enters heavy agent mode;
- introduce multiple long hidden continuation loops;
- make model output the source of canonical scenario state.

Their context should be assembled from:

`canonical D1/R2 scenario/work state + actor-scoped retrieved state + bounded conversation context + appropriate model role`

AI conversation state must never become authoritative for internship ownership, duration, scenario truth, scenario version, lifecycle state, authorization or completion eligibility.

---

## Learner naming and visible-language contract

Learner naming is Tutor-wide account personalization, not Virtual Internship scenario state. Future Virtual Internship workplace actors, Mentor conversations and other personalized surfaces must reuse the same resolved Murikah account name instead of creating a second preferred-name field.

The contract is:

- `tutor_accounts.preferred_name` is the durable explicit preference;
- future internship features use the same account resolver and fallback behavior;
- changing a preferred name does not mutate any legal name, full name, identity record or scenario actor identity;
- Virtual Internship user-visible copy must not contain the Unicode em dash U+2014;
- workplace actors, Mentor responses, assessor feedback and future generated reports must use Murikah's shared visible-text policy and assistant-output sanitizer;
- learner-authored source text remains learner-authored and is not rewritten merely to satisfy Murikah's generated/displayed-text style.

This naming and visible-language contract is cross-cutting infrastructure. Phase 2 must consume it rather than inventing another naming or punctuation system.

---

## SUBSEQUENT DEVELOPMENT REQUIREMENT

Before implementing Phase 2 or modifying Virtual Internship persistence, scenario state, artifacts, assessment, Competency Passport, reports, internship APIs or AI interactions, read the **Phase 1 Implementation Record** above.

Reuse its ownership, scenario-versioning, duration, idempotency, R2-key and authenticated-actor contracts. Do not create a competing persistence, ownership or identity model.

---

## 38. Change log

### 2026-09-21 — Foundation specification

- Defined Virtual Internship as a persistent simulated workplace.
- Set minimum qualifying duration to 90 calendar days.
- Defined realistic work, learning tracking, artifacts, actors, workplace politics and assessment.
- Defined AI model roles and separation.
- Defined Competency Evidence Record and Competency Passport.
- Defined performance report and completion letter requirements.
- Defined broad career coverage and physical-competency limits.
- Added implementation checklist and test contract.
- Established placeholder as the first implementation milestone.
