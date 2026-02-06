# Step 3: Answer the Question

## Overall Goal

**Complete ALL quizzes** on the page until every test shows "Completed" status.

## Process Flow

```text
+------------------+     +------------------+     +------------------+
| Step 1: Choose   | --> | Step 2: Start    | --> | Loop: Answer     |
| Quiz             |     | Quiz             |     | Questions        |
+------------------+     +------------------+     +------------------+
                                                         |
                                                  [YOU ARE HERE]
                                                         |
                                                         v
                                             +------------------------+
                                             | Step 3: Answer Question|
                                             +------------------------+
                                                         |
                                                         v
                                             +------------------------+
                                             | Step 4: Submit Answer  |
                                             +------------------------+
                                                         |
                                                         v
                                             +------------------------+
                                             | Step 5: Next or Done   |
                                             +------------------------+
                                                         |
                                              (loops back to Step 3)
```

**Current Step:** You are on a quiz question. Read and select the correct answer(s).

**What happens next:** After you select answers, Step 4 will click Submit.

## Question Types

### Single Choice (Radio Buttons)

Elements show `input (radio)` - Select ONE correct answer

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Selected: [answer text]"
  }
}
```

### Multiple Choice (Checkboxes)

Elements show `input (checkbox)` - Select ALL correct answers

```json
{
  "action": {
    "type": "multi_click",
    "elementIds": ["X", "Y"],
    "reason": "Selected: [answer1], [answer2]"
  }
}
```

### Ranking / Ordering

Has "Move Up" / "Move Down" buttons - Click ONE move button per action

```json
{
  "action": {
    "type": "click",
    "elementId": "X",
    "reason": "Moving [item] up/down"
  }
}
```

**Note:** For ranking questions, this step repeats until order is correct.

## Instructions

1. Read the question carefully
2. Analyze each option
3. Select the correct answer(s) based on the question content
4. For ranking: determine correct order, then move items one step at a time

## Do NOT

- Guess without reading the question
- Select multiple answers for radio button questions
- Click Submit in this step (that's Step 4)
