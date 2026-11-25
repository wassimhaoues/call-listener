# Product Scope and Candidate Journey

## Primary user and objective

The app serves a person applying for a job. It helps that candidate understand the role, recall relevant experience, structure answers, ask useful questions, and review their own interview. Every screen, prompt, role label, and output must use this perspective.

Microphone audio means **candidate / you**. System audio means **interviewer** in the initial two-input design. Multiple remote interviewers remain one remote audio source; do not claim individual speaker identification without adding and validating it.

## Before the interview

Replace generic “Caller / Me / Objectives” fields with:

- Candidate profile: name, experience, skills, projects, education, and factual achievements supplied by the candidate.
- Job offer: title, company, seniority, responsibilities, required skills, and pasted job description.
- Interview settings: language, stage (recruiter, technical, behavioral, final), goals, and preferred answer length.
- Model settings: selected OpenRouter model, capability/availability status, and estimated usage cost.

Prepare a role-specific introduction, an experience-to-requirement map, example STAR stories (Situation, Task, Action, Result), topics to revise, and questions the candidate can ask. Ask for missing facts rather than inventing qualifications, employers, metrics, or personal experience. Preserve source references to candidate-entered evidence.

## During the interview

Show the latest interviewer question, live transcript, device meters, connection health, and concise answer support. Suggestions should begin with a short answer outline, with optional detail and relevant experience examples. Technical questions may need an explanation or code excerpt; behavioral questions may need a STAR structure. Do not force every answer into the same template.

Support pause/resume, stop, shorter answer, expand, regenerate, and “help me clarify this question.” The candidate decides what to say. Assistance is displayed privately in the app and is not automatically spoken into the call. Retain the previous useful suggestion while the next is loading, visibly marking stale or cancelled output.

## After the interview

Provide the candidate with a summary of questions discussed, their own answers, strengths, topics to improve, and follow-up notes. Base observations on the transcript, distinguish suggestions from things actually said, and avoid predicting hiring outcomes. Allow explicit save/export/delete choices.

## Release scope

The first useful interview release combines candidate/job context, selectable models, grounded live suggestions, stable audio, and clear errors. Preparation and live support take priority over PDF parsing, dashboards, and advanced retrieval.

Later additions may include candidate-controlled PDF/DOCX import, reusable profiles, and mock interview practice where the model simulates questions for the candidate. Mock mode is separate from live mode and does not create an interviewer-facing product.

Not in this roadmap: recruiter workflows, candidate scoring/ranking, automated hiring decisions, built-in meeting hosting, screen capture, voice impersonation, model training, or a cross-platform desktop rewrite. “Improve the model” initially means better model selection, prompts, context, orchestration, and evaluation—not training new weights.
