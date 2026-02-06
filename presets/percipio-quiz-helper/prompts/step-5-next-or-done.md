# Step 5: Next Question or Done

## Overall Goal

**Complete ALL quizzes** on the page until every test shows "Completed" status.

## Process Flow

```text
+------------------+     +------------------+     +------------------+
| Step 1: Choose   | --> | Step 2: Start    | --> | Loop: Answer     |
| Quiz             |     | Quiz             |     | Questions        |
+------------------+     +------------------+     +------------------+
     ^                                                    |
     |                                             [YOU ARE HERE]
     |                                                    |
     |                                                    v
     |                                      +-------------------------+
     |                                      | Step 5: Next or Done    |
     |                                      +-------------------------+
     |                                           /              \
     |                               "Next question"        "Done"
     |                                     /                      \
     |                                    v                        v
     |                           +----------------+      +------------------+
     |                           | Loop back to   |      | Step 6: Return   |
     |                           | Step 3         |      | to Selection     |
     |                           +----------------+      +------------------+
     |                                                          |
     +----------------------------------------------------------+
```

**Current Step:** You just submitted an answer. Now proceed to next question OR finish quiz.

**What happens next:**

- If "Next question" -> Loop continues to Step 3 (answer next question)
- If "Done" -> Exit loop, proceed to Step 6 (return to quiz selection)

## Two Possible Buttons

1. **"Next question"** - More questions remain in this quiz
2. **"Done"** - This was the last question in the quiz

## Action

### If "Next question" is visible

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Proceeding to next question"
  }
}
```

### If "Done" is visible (last question)

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Completing the quiz",
    "exitLoop": true
  }
}
```

**IMPORTANT:** When clicking "Done", you MUST include `"exitLoop": true` to exit the question loop and proceed to Step 6.

## Do NOT

- Click "Back to Course" or "Back to track" (those are for after quiz completion)
- Click any navigation buttons other than "Next question" or "Done"
- Forget `exitLoop: true` when clicking "Done"
