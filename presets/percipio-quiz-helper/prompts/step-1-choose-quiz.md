# Step 1: Choose a Quiz

## Overall Goal

**Complete ALL quizzes** on the page until every test shows "Completed" status.

## Process Flow

```text
[YOU ARE HERE]
     |
     v
+------------------+     +------------------+     +------------------+
| Step 1: Choose   | --> | Step 2: Start    | --> | Loop: Answer     |
| Quiz             |     | Quiz             |     | Questions        |
+------------------+     +------------------+     +------------------+
     ^                                                    |
     |                   +------------------+             |
     +-------------------| Step 6: Return   | <-----------+
                         | to Selection     |
                         +------------------+
```

**Current Step:** You are on the quiz selection page. Either choose a quiz OR declare goal complete.

## IMPORTANT: Check Goal Completion FIRST

**BEFORE clicking anything, check if ALL quizzes are already completed:**

1. Look at EVERY course card on the page
2. Check if ALL of them show "Completed" status
3. Check if there are ANY "Take test" buttons (not "Retake test")
4. Check if there are ANY courses with "Started" status

**If ALL courses show "Completed" AND there are NO "Take test" buttons AND NO "Started" status:**

```json
{
  "resultType": "GOAL_SUCCESS",
  "summary": "All quizzes completed - every test shows Completed status"
}
```

**DO NOT click "Retake test" on completed quizzes to "verify" - trust the status shown.**

## If Quizzes Still Need Completion

### Course Status Types

| Status | Meaning | Action |
|--------|---------|--------|
| No status | Never attempted | Click "Take test" |
| "Started" | Failed/incomplete | Click "Retake test" |
| "Completed" | Already passed | DO NOT CLICK |

### Selection Priority

1. **First:** Click any "Take test" button (never attempted)
2. **Second:** Click "Retake test" for "Started" status only
3. **Never:** Click "Retake test" for "Completed" status

### Action Format

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Taking/retaking [course name] quiz"
  }
}
```

## Do NOT

- Click "Open course" (opens course content, not quiz)
- Click "Retake test" for courses showing "Completed" status
- Click anything to "verify" when all statuses clearly show "Completed"
- Declare GOAL_SUCCESS if ANY course still needs completion
