// =============================================================================
// HANDLER UTILITIES
// =============================================================================
// Shared helper functions for state machine handlers

import type { PageState, PageContext } from '../types/index.js';

/**
 * Extract key contextual information from page state.
 * Looks for topic/course name and progress indicators like "Question X of Y".
 */
export function extractPageContext(pageState: PageState): PageContext {
  const context: PageContext = {
    title: pageState.title,
  };

  // Extract topic from title (often format: "Platform - Topic Name" or "Topic Name | Platform")
  const title = pageState.title;
  if (title) {
    // Common patterns: "Percipio Skill Benchmark Building Trust with Business Ethics"
    // Extract the meaningful part after common prefixes
    const topicMatch = title.match(/(?:Skill Benchmark|Course|Quiz|Assessment|Module)\s+(.+)/i);
    if (topicMatch) {
      context.topic = topicMatch[1].trim();
    } else if (!title.includes('|') && !title.includes(' - ')) {
      // Simple title, use as-is
      context.topic = title;
    }
  }

  // Extract progress indicator from markdown content
  // Common patterns: "Question 3 of 5", "Question: 3/5", "Q3/5", "Step 2 of 10"
  const markdown = pageState.markdown;
  if (markdown) {
    const progressPatterns = [
      /Question\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
      /Q(\d+)\s*(?:of|\/)\s*(\d+)/i,
      /Step\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
      /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:questions?|steps?|items?)/i,
    ];

    for (const pattern of progressPatterns) {
      const match = markdown.match(pattern);
      if (match) {
        context.progress = `${match[1]}/${match[2]}`;
        break;
      }
    }
  }

  return context;
}
