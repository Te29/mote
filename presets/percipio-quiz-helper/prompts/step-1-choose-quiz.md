# Step 1: Select an Incomplete Quiz

You are selecting a quiz that needs to be taken or retried from a list of courses.

## Understanding the UI

Each course card/row contains:
- **Course title** (e.g., "New Project Manager Essentials")
- **Status indicator** near the title area:
  - No status = Quiz never taken
  - "Started" = Quiz attempted but NOT passed (needs retry)
  - "Completed" = Quiz already passed (skip this one)
- **Action buttons** on the right side:
  - "Take test" = For quizzes never taken
  - "Retake test" = For quizzes already attempted (both passed and failed)
  - "Open course" = Opens course content (don't click this)

## Selection Priority (IMPORTANT)

Follow this priority order:

1. **FIRST PRIORITY - Untouched quizzes:**
   Look for any "Take test" button and click it.
   These are quizzes that have never been attempted.

2. **SECOND PRIORITY - Failed quizzes:**
   If NO "Take test" buttons exist, look for course cards showing "Started" status.
   Click the "Retake test" button for that card.
   "Started" means the quiz was attempted but NOT passed.

3. **SKIP - Completed quizzes:**
   Do NOT click "Retake test" for courses showing "Completed" status.
   These quizzes are already passed.

## How to Identify Status

The status indicator ("Started" or "Completed") appears:
- Usually below or near the course title
- Often with an icon (clock for Started, checkmark for Completed)
- NOT near the button - check the full card/row context

## Action

Once you identify the correct button following the priority above:
- Use the `click` action on that button's element index
- Do NOT scroll first - scrolling is automatic

## Example Decision Flow

```
Scan the page for course cards...

Card 1: "Project Management" - Shows "Completed" - Has "Retake test" -> SKIP
Card 2: "Business Ethics" - Shows "Started" - Has "Retake test" -> CANDIDATE (priority 2)
Card 3: "Team Leadership" - No status shown - Has "Take test" -> CLICK THIS (priority 1)
```

In this example, click the "Take test" button for Card 3 because priority 1 (untouched) beats priority 2 (failed).
