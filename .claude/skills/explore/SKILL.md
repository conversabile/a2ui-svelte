---
name: explore
description: Explain part of this codebase as one causal chain — existing code, an implementation plan, a work package, an open issue, or a design question. Explanation only, no edits.
argument-hint: [what to explain]
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
---

You are explaining part of this codebase to an engineer who knows the project but
not this particular thing. The thing may be existing code, an implementation plan,
a work package, an open issue, or a design question the user is weighing.

Produce a logically connected narrative. Answer as ONE CAUSAL CHAIN, never a list of facts. Every sentence must be forced
by the one before it. If two sentences could be swapped without loss, the link
between them is missing: find it, or delete one.

Pick the shape that fits the subject.

**A. Something that CHANGES** (a WP, a plan, a fix, a refactor):

1. The defect: what goes wrong today, and when. Concretely.
2. What that defect makes impossible to keep, and why.
3. Each new element — file, function, field, type — introduced ONLY where the
   chain requires it. State the need first, name the thing second. Never name a
   thing before the sentence that forces it to exist.
4. What gets deleted, and which link in the chain killed it.
5. What changes in observable behaviour.

**B. Something that EXISTS** (how a mechanism works, what happens when X):

Follow the real path in the real order — the call, the data, the lifecycle. One
step per idea, each step opening with a short bold lead-in. Every step must
answer "and then what?" from the step above. End with the consequence the reader
actually cares about.

## Language — the reader is not a native English speaker

- Short sentences. Subject and verb at the front.
- Plain words. If a technical term is unavoidable, define it in one clause the
  first time you use it. Never invent a metaphor and then rely on it.
- Avoid word forms whose tense is ambiguous in writing ("read", "set", "lead").
  Rewrite the sentence instead.
- Do not use a word to mean two things in the same answer.

## Hard rules

- If the user's premise looks wrong, say so first, in one or two sentences,
  before explaining anything else. Then explain.
- Answer the question actually asked. If asked "does X change this?", the first
  word is Yes or No, then the reason.
- Everything must trace back to step 1 (shape A) or to the path (shape B). If you
  cannot trace it, cut it.
- Anchor claims to the real code with [file.ts:42](path/file.ts#L42) links, and
  check the code before claiming it. Do not describe what you have not read.
- Do not paste existing code as illustration. Show code only when the code IS the
  answer: a few lines, and only for what is new or what the user must write.
- Separate clearly what exists today from what would change.
- If a link is genuinely unknown, or the plan does not say, state it as an open
  question. Never fill a gap with a plausible-sounding name.
- Under 200 words by default. A step-by-step narration may run longer, but every
  step must earn its place.

## Follow-up questions

Re-enter the chain where the user is asking and answer from there. Do not restate
the whole chain. Do not add new names. Do not introduce jargon the user has not
used.

## The subject

$ARGUMENTS
