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
- [ ] Add authenticated Tutor sidebar entry.
- [ ] Add authenticated `/virtual-internship` placeholder route.
- [ ] Add guest-visible Virtual Internship entry.
- [ ] Add build/preflight checks protecting the placeholder and specification.

### Phase 1 — persistence foundation

- [ ] Define internship/scenario D1 schema.
- [ ] Define R2 artifact paths.
- [ ] Add migrations.
- [ ] Add actor-bound persistence adapter methods.
- [ ] Add ownership/isolation tests.
- [ ] Add scenario versioning.
- [ ] Add internship start/stop/status APIs.
- [ ] Enforce 90-day qualifying-duration rule in backend code.

### Phase 2 — scenario engine

- [ ] Define scenario-pack JSON schemas.
- [ ] Build schema validation.
- [ ] Build canonical scenario-state service.
- [ ] Build actor knowledge boundaries.
- [ ] Build task graph.
- [ ] Build event graph.
- [ ] Build deterministic event triggers.
- [ ] Add demo scenario fixtures.
- [ ] Ensure AI cannot silently overwrite canonical truth.

### Phase 3 — AI orchestration

- [ ] Add model-role abstraction for actor, mentor, assessor and scenario director.
- [ ] Reuse Murikah provider/model configuration.
- [ ] Add bounded timeouts.
- [ ] Add retry/fallback.
- [ ] Add structured-output schemas.
- [ ] Add learner-safe failure messages.
- [ ] Add model/audit metadata.
- [ ] Test provider failure and malformed structured output.

### Phase 4 — internship workplace UI

- [ ] Build Virtual Internship dashboard.
- [ ] Build inbox.
- [ ] Build task/work queue.
- [ ] Build company/people view.
- [ ] Build document/evidence browser.
- [ ] Build meetings/timeline.
- [ ] Build Mentor surface.
- [ ] Build activity/reflection view.
- [ ] Preserve responsive/mobile behavior.

### Phase 5 — work artifact workflow

- [ ] Assignment open/acknowledge.
- [ ] Artifact drafting/upload.
- [ ] Submission.
- [ ] Version history.
- [ ] Supervisor review.
- [ ] Revision/resubmission.
- [ ] Completion.
- [ ] R2 object ownership.
- [ ] Artifact integrity metadata.

### Phase 6 — assessment and workplace dynamics

- [ ] Rubric engine.
- [ ] Structured assessor.
- [ ] Assistance-level recording.
- [ ] Midpoint review.
- [ ] Final review.
- [ ] Workplace politics event library.
- [ ] Ethics/escalation events.
- [ ] Bias/fairness guardrails.
- [ ] Evidence-based feedback tests.

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
