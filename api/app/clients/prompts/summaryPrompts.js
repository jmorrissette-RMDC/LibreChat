const { PromptTemplate } = require('@langchain/core/prompts');
/*
 * Without `{summary}` and `{new_lines}`, token count is 98
 * We are counting this towards the max context tokens for summaries, +3 for the assistant label (101)
 * If this prompt changes, use https://tiktokenizer.vercel.app/ to count the tokens
 */
const _DEFAULT_SUMMARIZER_TEMPLATE = `Summarize the conversation by integrating new lines into the current summary.

EXAMPLE:
Current summary:
The human inquires about the AI's view on artificial intelligence. The AI believes it's beneficial.

New lines:
Human: Why is it beneficial?
AI: It helps humans achieve their potential.

New summary:
The human inquires about the AI's view on artificial intelligence. The AI believes it's beneficial because it helps humans achieve their potential.

Current summary:
{summary}

New lines:
{new_lines}

New summary:`;

const SUMMARY_PROMPT = new PromptTemplate({
  inputVariables: ['summary', 'new_lines'],
  template: _DEFAULT_SUMMARIZER_TEMPLATE,
});

/*
 * Without `{new_lines}`, token count is 27
 * We are counting this towards the max context tokens for summaries, rounded up to 30
 * If this prompt changes, use https://tiktokenizer.vercel.app/ to count the tokens
 */
const _CUT_OFF_SUMMARIZER = `The following text is cut-off:
{new_lines}

Summarize the content as best as you can, noting that it was cut-off.

Summary:`;

const CUT_OFF_PROMPT = new PromptTemplate({
  inputVariables: ['new_lines'],
  template: _CUT_OFF_SUMMARIZER,
});

/*
 * Without `{new_lines}` and `{max_tokens}`, token count is 47
 * Used for proactive compaction — targets a specific token budget for output.
 */
const _COMPACT_SUMMARIZER_TEMPLATE = `You are compacting a conversation history to free up context space.

Summarize the following conversation into a concise summary. Your summary MUST fit within {max_tokens} tokens — be as concise as possible while preserving all key decisions, facts, file paths, outcomes, and any information the user or assistant would need to continue the conversation without re-reading the original.

Conversation:
{new_lines}

Summary:`;

const COMPACT_PROMPT = new PromptTemplate({
  inputVariables: ['new_lines', 'max_tokens'],
  template: _COMPACT_SUMMARIZER_TEMPLATE,
});

module.exports = {
  SUMMARY_PROMPT,
  CUT_OFF_PROMPT,
  COMPACT_PROMPT,
};
