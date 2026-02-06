# Step 6b: Return to Quiz Selection

## Overall Goal

**Complete ALL quizzes** on the page until every test shows "Completed" status.

## Process Flow

```text
+------------------+     +------------------+     +------------------+
| Step 1: Choose   | --> | Step 2: Start    | --> | Loop: Answer     |
| Quiz             |     | Quiz             |     | Questions        |
+------------------+     +------------------+     +------------------+
     ^                                                    |
     |                                                    v
     |                        +------------------------+  |
     |                        | Step 6a: Close Modal   |<-+
     |                        +------------------------+
     |                                    |
     |                                    v
     |                        +------------------------+
     |                        | Step 6b: Back to Track |
     |                        +------------------------+
     |                         [YOU ARE HERE]
     |                                    |
     +------------------------------------+
                    (cycle repeats for next quiz)
```

**Current Step:** Any modal is closed. Now click "Back to track" to return to quiz selection.

**What happens next:** After returning, Step 1 will check if more quizzes need completion.

## Action

Click "Back to track" to return to the quiz selection page.

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Returning to quiz selection page"
  }
}
```

## Step Completion

This step is complete when you see the quiz selection page with:

- Multiple course cards
- "Take test" or "Retake test" buttons visible

## Do NOT

- Click "Back to Course" (goes to course content, not quiz selection)
- Click "Retake test" (wait until back at selection page)
- Declare GOAL_SUCCESS here (that's determined in Step 1)
