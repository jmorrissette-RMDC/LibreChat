const multer = require('multer');
const express = require('express');
const { sleep } = require('@librechat/agents');
const { isEnabled, resolveImportMaxFileSize } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys, EModelEndpoint } = require('librechat-data-provider');
const {
  createImportLimiters,
  validateConvoAccess,
  createForkLimiters,
  configMiddleware,
} = require('~/server/middleware');
const { getConvosByCursor, deleteConvos, getConvo, saveConvo } = require('~/models/Conversation');
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { storage, importFileFilter } = require('~/server/routes/files/multer');
const { deleteAllSharedLinks, deleteConvoSharedLink } = require('~/models');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { importConversations } = require('~/server/utils/import');
const { deleteToolCalls } = require('~/models/ToolCall');
const getLogStores = require('~/cache/getLogStores');

const assistantClients = {
  [EModelEndpoint.azureAssistants]: require('~/server/services/Endpoints/azureAssistants'),
  [EModelEndpoint.assistants]: require('~/server/services/Endpoints/assistants'),
};

const router = express.Router();
router.use(requireJwtAuth);

router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 25;
  const cursor = req.query.cursor;
  const isArchived = isEnabled(req.query.isArchived);
  const search = req.query.search ? decodeURIComponent(req.query.search) : undefined;
  const sortBy = req.query.sortBy || 'updatedAt';
  const sortDirection = req.query.sortDirection || 'desc';

  let tags;
  if (req.query.tags) {
    tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
  }

  try {
    const result = await getConvosByCursor(req.user.id, {
      cursor,
      limit,
      isArchived,
      tags,
      search,
      sortBy,
      sortDirection,
    });
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching conversations', error);
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const convo = await getConvo(req.user.id, conversationId);

  if (convo) {
    res.status(200).json(convo);
  } else {
    res.status(404).end();
  }
});

router.get('/gen_title/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;
  let title = await titleCache.get(key);

  if (!title) {
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s (total ~15.5s max wait)
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const delay of delays) {
      await sleep(delay);
      title = await titleCache.get(key);
      if (title) {
        break;
      }
    }
  }

  if (title) {
    await titleCache.delete(key);
    res.status(200).json({ title });
  } else {
    res.status(404).json({
      message: "Title not found or method not implemented for the conversation's endpoint",
    });
  }
});

router.delete('/', async (req, res) => {
  let filter = {};
  const { conversationId, source, thread_id, endpoint } = req.body?.arg ?? {};

  // Prevent deletion of all conversations
  if (!conversationId && !source && !thread_id && !endpoint) {
    return res.status(400).json({
      error: 'no parameters provided',
    });
  }

  if (conversationId) {
    filter = { conversationId };
  } else if (source === 'button') {
    return res.status(200).send('No conversationId provided');
  }

  if (
    typeof endpoint !== 'undefined' &&
    Object.prototype.propertyIsEnumerable.call(assistantClients, endpoint)
  ) {
    /** @type {{ openai: OpenAI }} */
    const { openai } = await assistantClients[endpoint].initializeClient({ req, res });
    try {
      const response = await openai.beta.threads.delete(thread_id);
      logger.debug('Deleted OpenAI thread:', response);
    } catch (error) {
      logger.error('Error deleting OpenAI thread:', error);
    }
  }

  try {
    const dbResponse = await deleteConvos(req.user.id, filter);
    if (filter.conversationId) {
      await deleteToolCalls(req.user.id, filter.conversationId);
      await deleteConvoSharedLink(req.user.id, filter.conversationId);
    }
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.delete('/all', async (req, res) => {
  try {
    const dbResponse = await deleteConvos(req.user.id, {});
    await deleteToolCalls(req.user.id);
    await deleteAllSharedLinks(req.user.id);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

/**
 * Archives or unarchives a conversation.
 * @route POST /archive
 * @param {string} req.body.arg.conversationId - The conversation ID to archive/unarchive.
 * @param {boolean} req.body.arg.isArchived - Whether to archive (true) or unarchive (false).
 * @returns {object} 200 - The updated conversation object.
 */
router.post('/archive', validateConvoAccess, async (req, res) => {
  const { conversationId, isArchived } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (typeof isArchived !== 'boolean') {
    return res.status(400).json({ error: 'isArchived must be a boolean' });
  }

  try {
    const dbResponse = await saveConvo(
      req,
      { conversationId, isArchived },
      { context: `POST /api/convos/archive ${conversationId}` },
    );
    res.status(200).json(dbResponse);
  } catch (error) {
    logger.error('Error archiving conversation', error);
    res.status(500).send('Error archiving conversation');
  }
});

/** Maximum allowed length for conversation titles */
const MAX_CONVO_TITLE_LENGTH = 1024;

/**
 * Updates a conversation's title.
 * @route POST /update
 * @param {string} req.body.arg.conversationId - The conversation ID to update.
 * @param {string} req.body.arg.title - The new title for the conversation.
 * @returns {object} 201 - The updated conversation object.
 */
router.post('/update', validateConvoAccess, async (req, res) => {
  const { conversationId, title } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (title === undefined) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }

  const sanitizedTitle = title.trim().slice(0, MAX_CONVO_TITLE_LENGTH);

  try {
    const dbResponse = await saveConvo(
      req,
      { conversationId, title: sanitizedTitle },
      { context: `POST /api/convos/update ${conversationId}` },
    );
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error updating conversation', error);
    res.status(500).send('Error updating conversation');
  }
});

const { importIpLimiter, importUserLimiter } = createImportLimiters();
/** Fork and duplicate share one rate-limit budget (same "clone" operation class) */
const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
const importMaxFileSize = resolveImportMaxFileSize();
const upload = multer({
  storage,
  fileFilter: importFileFilter,
  limits: { fileSize: importMaxFileSize },
});
const uploadSingle = upload.single('file');

function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File exceeds the maximum allowed size' });
    }
    if (err) {
      return next(err);
    }
    next();
  });
}

/**
 * Imports a conversation from a JSON file and saves it to the database.
 * @route POST /import
 * @param {Express.Multer.File} req.file - The JSON file to import.
 * @returns {object} 201 - success response - application/json
 */
router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  handleUpload,
  async (req, res) => {
    try {
      /* TODO: optimize to return imported conversations and add manually */
      await importConversations({ filepath: req.file.path, requestUserId: req.user.id });
      res.status(201).json({ message: 'Conversation(s) imported successfully' });
    } catch (error) {
      logger.error('Error processing file', error);
      res.status(500).send('Error processing file');
    }
  },
);

/**
 * POST /fork
 * This route handles forking a conversation based on the TForkConvoRequest and responds with TForkConvoResponse.
 * @route POST /fork
 * @param {express.Request<{}, TForkConvoResponse, TForkConvoRequest>} req - Express request object.
 * @param {express.Response<TForkConvoResponse>} res - Express response object.
 * @returns {Promise<void>} - The response after forking the conversation.
 */
router.post('/fork', forkIpLimiter, forkUserLimiter, async (req, res) => {
  try {
    /** @type {TForkConvoRequest} */
    const { conversationId, messageId, option, splitAtTarget, latestMessageId } = req.body;
    const result = await forkConversation({
      requestUserId: req.user.id,
      originalConvoId: conversationId,
      targetMessageId: messageId,
      latestMessageId,
      records: true,
      splitAtTarget,
      option,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error forking conversation:', error);
    res.status(500).send('Error forking conversation');
  }
});

router.post('/duplicate', forkIpLimiter, forkUserLimiter, async (req, res) => {
  const { conversationId, title } = req.body;

  try {
    const result = await duplicateConversation({
      userId: req.user.id,
      conversationId,
      title,
    });
    res.status(201).json(result);
  } catch (error) {
    logger.error('Error duplicating conversation:', error);
    res.status(500).send('Error duplicating conversation');
  }
});

/**
 * Manually triggers context compaction for a conversation.
 * Summarizes the oldest messages (all but the newest 10% of the context window)
 * and stores the summary on the oldest message in the DB.
 * @route POST /:conversationId/compact
 */
router.post('/:conversationId/compact', async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user.id;

  const { getConvo } = require('~/models/Conversation');
  const convo = await getConvo(userId, conversationId);
  if (!convo) {
    return res.status(404).json({ message: 'Conversation not found' });
  }

  try {
    const { getMessages, updateMessage } = require('~/models');
    const messages = await getMessages({ conversationId });

    if (!messages || messages.length === 0) {
      return res.json({ message: 'No messages to compact' });
    }

    /** Lazy-import to avoid circular deps at module load time */
    const { OpenAI } = require('openai');
    const { COMPACT_PROMPT } = require('~/app/clients/prompts');

    /** Use the app-level OpenAI key as fallback for the summary call */
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.COMPACT_MODEL ?? 'gpt-4o-mini';

    const SUMMARY_RATIO = 0.7;
    const toSummarize = messages.slice(0, Math.floor(messages.length * SUMMARY_RATIO));

    const newLines = toSummarize
      .map((m) => {
        const role = m.role === 'assistant' ? 'Assistant' : 'User';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${role}: ${content}`;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = await COMPACT_PROMPT.format({ new_lines: newLines, max_tokens: 500 });
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    });

    const summary = response.choices?.[0]?.message?.content ?? '';
    if (!summary) {
      return res.json({ message: 'Compaction produced no summary' });
    }

    await updateMessage(req, {
      messageId: toSummarize[0].messageId,
      summary,
      summaryTokenCount: Math.ceil(summary.length / 4),
    });

    logger.debug(`[POST /:conversationId/compact] Compacted ${toSummarize.length} messages for ${conversationId}`);
    res.json({ message: `Compacted ${toSummarize.length} messages` });
  } catch (error) {
    logger.error('Error compacting conversation:', error);
    res.status(500).send('Error compacting conversation');
  }
});

module.exports = router;
