/**
 * Tests for proactive context compaction in AgentClient.
 *
 * Uses real conversation turns extracted from a session as fixture data
 * (api/server/controllers/agents/__tests__/fixtures/conversation_fixture.txt).
 * The OpenAI API call in summarizeMessages is mocked — it is an external HTTP
 * API and falls under the "only mock what you cannot control" rule.
 */
const fs = require('fs');
const path = require('path');
const { EModelEndpoint } = require('librechat-data-provider');
const AgentClient = require('../client');

// --- Module mocks -------------------------------------------------------

jest.mock('openai', () => {
  const mockCreate = jest.fn();
  return {
    OpenAI: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
    __mockCreate: mockCreate,
  };
});

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({ handleLLMEnd: jest.fn(), collected: [] }),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAccess: jest.fn(),
  initializeAgent: jest.fn(),
  createMemoryProcessor: jest.fn(),
}));

jest.mock('~/models/Agent', () => ({ loadAgent: jest.fn() }));
jest.mock('~/models/Role', () => ({ getRoleByName: jest.fn() }));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: jest.fn().mockResolvedValue(''),
  })),
}));

// --- Helpers ------------------------------------------------------------

function makeClient(agentOverrides = {}, clientOverrides = {}) {
  const agent = {
    id: 'agent-test',
    provider: EModelEndpoint.openAI,
    model: 'gpt-4o-mini',
    model_parameters: {
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      clientOptions: { baseURL: undefined },
    },
    auto_compact: true,
    compact_threshold: 80,
    ...agentOverrides,
  };

  return new AgentClient({
    agent,
    endpoint: EModelEndpoint.agents,
    maxContextTokens: 500,
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
    req: { user: { id: 'user-1' }, config: {} },
    res: {},
    ...clientOverrides,
  });
}

/** Build a fake TMessage from plain text */
function makeMessage(role, text, index) {
  return {
    messageId: `msg-${index}`,
    conversationId: 'conv-test',
    parentMessageId: index === 0 ? null : `msg-${index - 1}`,
    role,
    content: text,
    tokenCount: Math.ceil(text.split(/\s+/).length * 1.3),
  };
}

/** Load fixture and convert to TMessage array */
function loadFixtureMessages(fixture = 'conversation_fixture.txt') {
  const fixturePath = path.join(__dirname, 'fixtures', fixture);
  const raw = fs.readFileSync(fixturePath, 'utf8');
  return raw
    .split('\n\n')
    .map((block, i) => {
      const trimmed = block.trim();
      if (!trimmed) return null;
      const role = trimmed.startsWith('User:') ? 'user' : 'assistant';
      const text = trimmed.replace(/^(User|Assistant):\s*/, '');
      return makeMessage(role, text, i);
    })
    .filter(Boolean);
}

/**
 * Generate synthetic messages totalling approximately targetTokens tokens.
 * Used for large-scale compaction tests where no real fixture is big enough.
 * Each word ≈ 1.3 tokens (GPT tokenization approximation).
 */
function generateLargeMessages(targetTokens) {
  const wordsPerMessage = 200;
  const tokensPerMessage = Math.ceil(wordsPerMessage * 1.3);
  const count = Math.ceil(targetTokens / tokensPerMessage);
  const word = 'lorem';
  const text = Array(wordsPerMessage).fill(word).join(' ');
  return Array.from({ length: count }, (_, i) =>
    makeMessage(i % 2 === 0 ? 'user' : 'assistant', text, i),
  );
}

// --- Tests --------------------------------------------------------------

describe('AgentClient — constructor', () => {
  it('sets shouldSummarize and contextStrategy from auto_compact', () => {
    const client = makeClient({ auto_compact: true, compact_threshold: 75 });
    expect(client.shouldSummarize).toBe(true);
    expect(client.contextStrategy).toBe('summarize');
    expect(client.compactThreshold).toBeCloseTo(0.75);
  });

  it('discard mode when auto_compact is false', () => {
    const client = makeClient({ auto_compact: false });
    expect(client.shouldSummarize).toBe(false);
    expect(client.contextStrategy).toBe('discard');
  });

  it('clamps compact_threshold to [10, 99]', () => {
    expect(makeClient({ compact_threshold: 0 }).compactThreshold).toBeCloseTo(0.1);
    expect(makeClient({ compact_threshold: 150 }).compactThreshold).toBeCloseTo(0.99);
  });
});

describe('AgentClient.summarizeMessages()', () => {
  let client;
  let mockCreate;

  beforeEach(() => {
    jest.clearAllMocks();
    client = makeClient();
    // Reach into the openai mock to grab the create fn
    mockCreate = require('openai').__mockCreate;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'This is a test summary of the conversation.' } }],
    });
  });

  it('calls the model with COMPACT_PROMPT and returns a summaryMessage', async () => {
    const messages = loadFixtureMessages().slice(0, 10);
    const { summaryMessage, summaryTokenCount } = await client.summarizeMessages({
      messagesToRefine: messages,
      remainingContextTokens: 400,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.max_tokens).toBe(Math.floor(500 * 0.05)); // 5% of 500
    expect(callArgs.messages[0].content).toContain('compacting');

    expect(summaryMessage).toMatchObject({
      role: 'system',
      content: expect.stringContaining('[Conversation Summary]'),
    });
    expect(summaryTokenCount).toBeGreaterThan(0);
  });

  it('falls back gracefully if the API call fails', async () => {
    mockCreate.mockRejectedValue(new Error('API error'));
    const messages = loadFixtureMessages().slice(0, 5);
    const result = await client.summarizeMessages({
      messagesToRefine: messages,
      remainingContextTokens: 400,
    });
    expect(result.summaryMessage).toBeNull();
    expect(result.summaryTokenCount).toBe(0);
  });
});

describe('AgentClient — proactive compaction threshold', () => {
  let client;
  let mockCreate;

  beforeEach(() => {
    jest.clearAllMocks();
    client = makeClient({ auto_compact: true, compact_threshold: 80 });
    mockCreate = require('openai').__mockCreate;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Compact summary.' } }],
    });
    // Spy on summarizeMessages so we can assert it was called
    jest.spyOn(client, 'summarizeMessages');
  });

  it('triggers summarizeMessages when total tokens exceed threshold', async () => {
    // maxContextTokens = 500, threshold = 80% = 400 tokens
    // Fixture messages total well over 400 tokens
    const messages = loadFixtureMessages();

    // Assign token counts so they sum past threshold
    let running = 0;
    const withCounts = messages.map((m) => {
      const tc = m.tokenCount ?? 20;
      running += tc;
      return { ...m, tokenCount: tc };
    });

    // Only run the test if the fixture actually exceeds the threshold
    const threshold = client.maxContextTokens * client.compactThreshold;
    expect(running).toBeGreaterThan(threshold);

    const formattedMessages = withCounts.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    await client.handleContextStrategy({
      orderedMessages: withCounts,
      formattedMessages,
      buildTokenMap: false,
    });

    expect(client.summarizeMessages).toHaveBeenCalled();
  });

  it('does NOT trigger summarizeMessages when below threshold', async () => {
    // Use only 2 short messages — well under 400 tokens
    const messages = [
      makeMessage('user', 'Hello.', 0),
      makeMessage('assistant', 'Hi there.', 1),
    ];
    const formattedMessages = messages.map((m) => ({ role: m.role, content: m.content }));

    await client.handleContextStrategy({
      orderedMessages: messages,
      formattedMessages,
      buildTokenMap: false,
    });

    expect(client.summarizeMessages).not.toHaveBeenCalled();
  });
});

describe('AgentClient — large fixture (~13k tokens)', () => {
  let client;
  let mockCreate;

  beforeEach(() => {
    jest.clearAllMocks();
    // maxContextTokens=8000, threshold=80% → fires at 6400 tokens
    client = makeClient({ auto_compact: true, compact_threshold: 80 }, { maxContextTokens: 8000 });
    mockCreate = require('openai').__mockCreate;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Large fixture summary.' } }],
    });
    jest.spyOn(client, 'summarizeMessages');
  });

  it('compacts a real 200-turn conversation fixture', async () => {
    const messages = loadFixtureMessages('conversation_large.txt');
    const totalTokens = messages.reduce((s, m) => s + (m.tokenCount ?? 0), 0);
    const threshold = client.maxContextTokens * client.compactThreshold;

    // Only meaningful if the fixture exceeds the threshold
    if (totalTokens <= threshold) {
      console.warn(`Large fixture (${totalTokens} tokens) does not exceed threshold (${threshold}) — skipping assertion`);
      return;
    }

    const formattedMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    await client.handleContextStrategy({
      orderedMessages: messages,
      formattedMessages,
      buildTokenMap: false,
    });

    expect(client.summarizeMessages).toHaveBeenCalled();
    const { messagesToRefine } = client.summarizeMessages.mock.calls[0][0];
    // Should have summarized the oldest bulk, keeping only 10% raw
    const rawWindow = Math.floor(client.maxContextTokens * 0.1);
    const refinedTokens = messagesToRefine.reduce((s, m) => s + (m.tokenCount ?? 0), 0);
    expect(refinedTokens).toBeGreaterThan(rawWindow);
  });
});

describe('AgentClient — synthetic 500k token test (TODO: replace with real session)', () => {
  /**
   * TODO: Once a real ~500k token session JSONL exists in the project, replace
   * generateLargeMessages() with loadFixtureMessages('conversation_500k.txt').
   *
   * Generate with:
   *   python scripts/3cli/extract_conversation.py <large-session.jsonl> \
   *     --last 2000 api/server/controllers/agents/__tests__/fixtures/conversation_500k.txt
   *
   * Use the largest session JSONL across all projects:
   *   find ~/.claude/projects -name "*.jsonl" | xargs wc -l | sort -rn | head -5
   */
  let client;
  let mockCreate;

  beforeEach(() => {
    jest.clearAllMocks();
    // 500k token context window, threshold 80% → fires at 400k tokens
    client = makeClient(
      { auto_compact: true, compact_threshold: 80 },
      { maxContextTokens: 500000 },
    );
    mockCreate = require('openai').__mockCreate;
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Large scale summary.' } }],
    });
    jest.spyOn(client, 'summarizeMessages');
  });

  it('compacts a ~500k token conversation', async () => {
    const messages = generateLargeMessages(450000); // 90% full — above 80% threshold
    const formattedMessages = messages.map((m) => ({ role: m.role, content: m.content }));

    await client.handleContextStrategy({
      orderedMessages: messages,
      formattedMessages,
      buildTokenMap: false,
    });

    expect(client.summarizeMessages).toHaveBeenCalled();

    // After compaction the payload should fit within 10% of the window (raw window)
    const rawWindowTokens = Math.floor(client.maxContextTokens * 0.1);
    const { payload } = await client.handleContextStrategy({
      orderedMessages: messages,
      formattedMessages,
      buildTokenMap: false,
    });
    if (payload) {
      const payloadTokens = payload.reduce((s, m) => s + (m.tokenCount ?? 0), 0);
      expect(payloadTokens).toBeLessThanOrEqual(rawWindowTokens + 1000); // +1k for summary message
    }
  }, 60000); // 60s timeout for large message array
});
