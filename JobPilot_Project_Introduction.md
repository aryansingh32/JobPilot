# Chapter 1: Introduction to JobPilot

## 1.1 Introduction

JobPilot is a job discovery and application assistance platform designed to help job seekers find relevant opportunities, manage their information, and follow the progress of their applications. It combines a user-facing interface with backend services that collect job listings, match them to a user's profile, and execute supported application workflows. An administrative panel provides tools for managing the system, reviewing activity, and maintaining integrations.

The project addresses the repetitive nature of modern job hunting. A candidate may need to visit many career sites, search for suitable openings, enter the same personal and professional details repeatedly, and separately remember the status of each application. JobPilot brings these activities into a connected workflow. Its goal is to reduce repetitive work while allowing applicants to provide missing information and understand the outcome of application attempts.

## 1.2 Background

Online recruitment involves several independent systems. Employers publish opportunities on career pages and applicant tracking systems (ATS), while job seekers maintain résumés and profiles on different platforms. Each employer may use different form fields, validation rules, and submission procedures. Listings may also change or close over time. These differences make it difficult to manage applications consistently.

JobPilot addresses this fragmentation through job-source adapters and browser workflows. Source adapters retrieve available listings from supported services and convert them into a common representation. Application workflows describe the steps required to interact with supported forms. A profile and answer history can reduce repeated data entry, while the application timeline provides a record of progress and outcomes.

## 1.3 Problem Definition

Job seekers face several related problems:

- Relevant jobs are spread across multiple sources and use different descriptions and location formats.
- Manually comparing a job's role, skills, location, and experience requirements with a candidate's profile takes time.
- Application forms repeatedly request similar information, often with different field names or choices.
- Missing information, website validation, and verification challenges can interrupt an application.
- Tracking submitted, pending, failed, and uncertain applications across websites is difficult.
- Website changes can cause automated interactions to fail and require maintenance.

The problem addressed by JobPilot is to build a unified system that supports discovery, matching, application assistance, and tracking while accounting for differences between external websites and retaining user control over important decisions.

## 1.4 Aim

The aim of JobPilot is to develop an integrated application that simplifies job searching and assists users throughout the application process through profile-based matching, reusable information, asynchronous automation, and application tracking.

## 1.5 Objectives

1. Collect job listings from supported job boards and normalize their information.
2. Enable users to maintain their profiles, résumés, preferences, and relevant answers.
3. Search, filter, and rank jobs using factors such as role, skills, location, workplace, and experience.
4. Assist with application forms by using available user information and requesting missing answers where needed.
5. Provide review and confirmation mechanisms according to the applicable user settings and workflow rules.
6. Track application progress and distinguish confirmed outcomes from failed or uncertain attempts.
7. Provide administrators with tools to maintain sources, workflows, workers, and operational settings.
8. Use modular services and queues to support long-running tasks without blocking the user interface.

## 1.6 Purpose and Scope

The project's primary users are job seekers who want to find opportunities and manage applications more efficiently. Administrative users configure and monitor the platform. The scope includes user onboarding and profile management, job ingestion, job discovery and recommendations, application assistance, application status tracking, and operational administration.

The platform integrates with supported external job sources and employer application pages. Coverage depends on the source adapter, available data, and the corresponding workflow. JobPilot assists with the application process; it cannot guarantee a job offer, employer response, or successful submission on every external site.

## 1.7 Overall Working of the System

```text
 Job seeker
     │
     ▼
 Web / Android interface ──────► API service
     │                                │
     │                         ┌──────┴────────┐
     │                         ▼               ▼
     │                    PostgreSQL      Redis / queues
     │                         ▲               │
     │                         │               ▼
     │                   Job records      Background workers
     │                         ▲          /             \
     │                         │         ▼               ▼
     │                   Job source APIs           Browser workflows
     │                                                   │
     └──────────── Review, questions, status ◄───────────┘
                                                         │
                                                         ▼
                                                  Employer portal

 Administrator ──► Admin panel ──► Admin service ──► Sources, workflows and workers
```

A typical user journey follows these steps:

1. **Create a profile:** The user signs in, enters relevant information, and can upload a résumé and set preferences.
2. **Collect job data:** Background processes poll configured job sources, normalize records, and store job information.
3. **Discover opportunities:** The user searches or views recommendations. Matching considers information available in the user's profile and the job record.
4. **Start an application:** The user selects a job or provides an application URL. The system selects a suitable workflow and schedules a background run.
5. **Complete the form:** The worker opens a browser, identifies relevant form fields, and uses available answers. It can ask the user for information that is required but unavailable.
6. **Review and submit:** The application can pause for user review. Configured automatic submission is subject to the project's review policy; some cases still require review or further input.
7. **Track the outcome:** Status and timeline information are stored and presented to the user. An uncertain submission is distinct from a confirmed submission.

## 1.8 Frontend: User Interface

The frontend is the part of JobPilot with which users interact directly. It is built with React and TypeScript, using the Vite and TanStack ecosystem. Capacitor provides Android packaging for the application. The interface communicates with backend APIs and receives updates for longer-running activity.

### 1.8.1 Profile and onboarding

The profile and onboarding experience collects information relevant to job applications, such as contact details, skills, experience, preferences, and résumé information. Having this information in one place makes it available for matching and supported form-filling workflows. The quality and completeness of the profile influence the usefulness of recommendations and the number of questions that need to be asked during an application.

### 1.8.2 Job discovery

The user can explore job listings and view information such as title, employer, location, and workplace. Search and filtering help narrow the available opportunities. Recommendations use profile attributes to identify potentially relevant jobs; they are decision support and do not guarantee eligibility or selection.

### 1.8.3 Applications and progress

The application interface allows users to initiate supported applications and follow their progress. When a workflow needs information or review, the interface can present the pending request. Application details and timelines help users distinguish work in progress, results requiring attention, and completed or failed runs.

### 1.8.4 Conversational and interactive features

The project includes a chat-oriented interface that can help route user requests and display relevant interface elements. Background tasks may take longer than an ordinary page request, so the interface provides status information and interaction points instead of requiring the user to wait on a single synchronous response.

## 1.9 Backend: Services and Data Processing

The backend is primarily implemented using Node.js and TypeScript. It separates interactive API requests from background execution. PostgreSQL stores structured application data, while Redis and BullMQ support queues and coordination between services.

### 1.9.1 API service

The API service handles requests from the user interface. Its responsibilities include user-related endpoints, profiles, résumés, job discovery, applications, and responses to pending questions or reviews. It validates and routes requests and coordinates work that must continue in the background.

### 1.9.2 Job ingestion and normalization

The platform maintains configured job sources. A scheduler identifies sources due for polling, and workers use appropriate adapters to retrieve listings. Source-specific data is transformed into a common structure so that jobs can be searched and compared consistently. Records are updated as source information changes, including the status of jobs that are no longer available.

Examples of supported source integrations documented in the project include Greenhouse, Lever, Ashby, SmartRecruiters, Workable, and Recruitee. The extent and reliability of integration vary by source and workflow.

### 1.9.3 Matching and recommendations

The matching component evaluates candidate jobs against profile information. The code considers role fit, skill overlap, location, workplace preference, and seniority or experience, and it can exclude unsuitable jobs using eligibility rules. Skills are represented using sets for membership checks, and candidate results are filtered and sorted by score. The exact score depends on available data and implementation rules; it should be interpreted as a ranking aid rather than a prediction of hiring success.

### 1.9.4 Application execution

When an application starts, the system resolves the job and chooses an appropriate workflow. A background worker uses Playwright and a browser to execute the workflow. Depending on the form, the workflow may navigate to a page, identify fields, fill values, upload a résumé, request missing answers, pause for review, and submit.

The application engine records progress and outcome information. External forms and their behavior vary, and a click on a submit button alone does not always establish that an employer received the application. The system therefore tracks uncertain outcomes separately where confirmation is unavailable.

### 1.9.5 Scheduler, queues and workers

The scheduler initiates periodic work such as polling configured sources and housekeeping. Redis-backed queues separate task creation from execution, while workers consume jobs and perform operations such as polling, parsing, and browser execution. This structure allows slow or interrupted external interactions to be handled independently of normal interface requests.

### 1.9.6 Storage and security

PostgreSQL stores records including profiles, jobs, application data, workflows, and operational information. Redis supports queues and short-lived coordination. Access controls and user sessions are important because résumés, contact information, and application answers are sensitive. The project includes administrative controls and audit capabilities, but production deployment also requires appropriate infrastructure configuration, backups, and ongoing security maintenance.

## 1.10 Admin Panel

The admin panel is the operational interface for people responsible for configuring and monitoring JobPilot. It communicates with a separate administrative service and is intended for authorized staff rather than ordinary job seekers.

Its documented areas include:

- **Overview and applications:** Inspect system activity, application status, and execution details.
- **Users and profiles:** Support account and user-related operations.
- **Job sources:** Add or configure supported sources, test source settings, control polling, and manage listings.
- **Workflows:** Create, edit, test, publish, and maintain ordered browser action plans.
- **Recorder and test profile:** Capture interactions for a workflow and test it using a designated profile before publication.
- **Queues, browsers and workers:** Inspect running tasks and worker activity, and use available operational controls.
- **Settings and administration:** Manage runtime settings, team permissions, audit information, and AI-related configuration.
- **Observability:** Review logs, errors, metrics, and other diagnostic information.

The admin panel is important because external sites change over time. A workflow that previously found a field or button may need adjustment after an employer updates its form. Testing, monitoring, and controlled publication help maintain these integrations.

## 1.11 Data Structures and Algorithms

JobPilot uses several fundamental computing concepts:

- **Sets and hash-based lookup:** Compare normalized user skills with skills associated with jobs efficiently.
- **Filtering and ranking:** Apply eligibility rules, calculate relevance scores, and sort suitable jobs for display.
- **Queues:** Manage background work such as job polling and browser execution.
- **Ordered sequences:** Represent workflow steps that are executed in a defined order.
- **Maps and indexed records:** Associate users, jobs, application states, and remembered answers with their identifiers.
- **String normalization and matching:** Compare different representations of roles, locations, skills, and form questions.

For a simple in-memory ranking pass over `n` candidate jobs, scoring is proportional to the work needed to examine each job and its attributes, while sorting `k` eligible results generally takes O(k log k). Database access, indexing, networking, and the number of skills affect actual execution time.

## 1.12 Advantages

- Brings job discovery and application tracking into a unified experience.
- Reduces repeated entry of profile information on supported forms.
- Uses multiple factors to make job discovery more relevant to the user.
- Provides mechanisms for questions, review, and status visibility.
- Uses background processing for work that may take significant time.
- Gives administrators tools to maintain sources and workflows.

## 1.13 Limitations

- External websites can change their forms, access rules, or APIs without notice.
- Some sites need specialized workflows, and support is not uniform across employers.
- Verification challenges and unfamiliar questions may require user interaction.
- Incomplete profiles or job descriptions can reduce matching quality.
- A submission may be uncertain if the external site does not provide a detectable confirmation.
- Reliability at production scale depends on infrastructure, monitoring, security, backups, and further real-world testing.
- The project does not guarantee employment, employer response, or successful submission.

## 1.14 Future Scope

Possible improvements include broader support for applicant tracking systems, more reliable site-specific workflows, better accessibility, improved recommendation evaluation, stronger operational monitoring, and infrastructure improvements. Java may also be used for future components or algorithm prototypes; the existing services described above use TypeScript and Node.js. Any new component would require integration and testing before it becomes part of the running platform.

## 1.15 Conclusion

JobPilot applies web technologies, data processing, algorithms, and browser automation to the practical problem of job searching. Its user interface supports discovery and application management, its backend coordinates matching and execution, and its admin panel supports the maintenance of sources and workflows. Together, these components provide a foundation for reducing repetitive work while making the limits and outcomes of automation visible.

## Project sources consulted

- `docs/how-it-works.md` — service architecture, job ingestion, workflows, and administrative functions; this document notes that parts are stale.
- `docs/competitive/production-status.md` — implementation status, subsequent changes, and known operational limitations.
- `backend/packages/shared/jobs/matcher.ts` — job scoring, eligibility, and sorting logic.
- `chatflow-interface/package.json` — frontend technology and Android build configuration.
- `backend/package.json` — backend service and testing scripts.
