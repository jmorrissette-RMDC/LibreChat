# LibreChat Fork — High-Level Design

**Status:** Draft
**Date:** 2026-04-08
**PRD Reference:** `docs/fork/PRD.md`

---

## 1. Overview

This document describes the data flows, component architecture, and upstream integration points for the three fork features. Each section traces the complete path from user action to persistent state and back.

---

## 2. Feature 1: Default-Enabled MCP Toggle

### 2.1 Data Flow

```
User toggles switch on MCPServerCard
  ↓
MCPServerCard.tsx writes to mcpDefaultEnabledAtom (localStorage-persisted Jotai atom)
  ↓  [store/mcp.ts]
User clicks "New Chat"
  ↓
useNewConvo.ts bumps mcpNewChatGenAtom
  ↓
useMCPSelect.ts useEffect detects gen change + isNewConvo
  ↓
Reads mcpDefaultEnabledAtom, filters by configuredServers
  ↓
Writes to mcpValuesAtomFamily (per-conversation MCP selection)
  ↓
Writes to ephemeralAgentByConvoId('new').mcp
  ↓  [store/agents.ts]
User sends message
  ↓
useChatFunctions.ts:125 captures ephemeralAgent via getEphemeralAgent(conversationId)
  ↓
ephemeralAgent included in SSE submission payload
  ↓
Backend: applyContextToAgent (context.ts:139)
  ↓
For non-agent chats: uses ephemeralAgent.mcp
For real agents: uses extractMCPServers(agent) — ignores ephemeralAgent.mcp
```

### 2.2 Files Changed

| File | Change |
|------|--------|
| `client/src/components/SidePanel/MCPBuilder/MCPServerCard.tsx` | Toggle switch UI, writes to atom |
| `client/src/store/mcp.ts` | `mcpDefaultEnabledAtom`, `mcpNewChatGenAtom` |
| `client/src/hooks/MCP/useMCPSelect.ts` | Effect applies defaults on new chat |
| `client/src/hooks/useNewConvo.ts` | Bumps `mcpNewChatGenAtom` |
| `packages/api/src/agents/context.ts` | Guards `ephemeralAgent.mcp` for real agents |

### 2.3 Upstream Integration Points

| Integration | File | Line | Hook Type |
|-------------|------|------|-----------|
| MCP server card rendering | `MCPServerCard.tsx` | Existing component | Modified — added toggle |
| New chat lifecycle | `useNewConvo.ts` | Return block | Modified — added `bumpMcpGen` |
| Ephemeral agent capture | `useChatFunctions.ts` | 125 | Existing — no change |
| MCP tool injection | `context.ts` | 139 | Modified — added agent guard |

---

## 3. Feature 2: Proactive Context Compaction

### 3.1 Data Flow — Auto Compact

```
Agent creator sets auto_compact=true, compact_threshold=80 in Advanced panel
  ↓
AutoCompact.tsx → Controller → react-hook-form field.onChange
  ↓
AgentPanel.tsx:onSubmit → composeAgentUpdatePayload includes auto_compact, compact_threshold
  ↓
useUpdateAgentMutation → dataService.updateAgent → PATCH /api/agents/:id
  ↓
v1.js:348 → agentUpdateSchema.parse (Zod validates auto_compact: boolean, compact_threshold: number)
  ↓
v1.js:351 → removeNullishValues (preserves true/false and numbers)
  ↓
v1.js:412 → updateAgent() → MongoDB findOneAndUpdate
  ↓  [Persisted to agent document]

User sends message to agent
  ↓
AgentClient constructor reads auto_compact, compact_threshold from options.agent
  ↓
Sets this.shouldSummarize = auto_compact
Sets this.contextStrategy = auto_compact ? 'summarize' : 'discard'
Sets this.compactThreshold = compact_threshold / 100
  ↓
buildMessages() → handleContextStrategy()
  ↓
BaseClient.js: calculates total token count
If totalTokens >= maxContextTokens * compactThreshold:
  ↓
  Passes reduced maxContextTokens (10% of window) to getMessagesWithinTokenLimit
  ↓
  Oldest messages become messagesToRefine
  ↓
  AgentClient.summarizeMessages() called
    ↓
    Formats messages as text transcript
    ↓
    Calls agent's own model via OpenAI SDK with COMPACT_PROMPT
    ↓
    Token budget: 5% of maxContextTokens
    ↓
    Returns { summaryMessage, summaryTokenCount }
  ↓
  Summary prepended to payload as system message
  ↓
  Result: ~5% summary + ~10% raw = ~15% used, ~85% free
```

### 3.2 Data Flow — Manual /compact

```
User types "/compact" in prompt textarea, presses Enter
  ↓
useSubmitMessage.ts:26 detects text.trim().toLowerCase() === '/compact'
  ↓
methods.reset() (clears input)
  ↓
compactConversation(conversationId) — fires mutation
  ↓
POST /api/convos/:conversationId/compact
  ↓
convos.js route handler:
  1. getConvo(userId, conversationId) — ownership check
  2. getMessages({ conversationId }) — load all messages
  3. toSummarize = messages.slice(0, Math.floor(length * 0.7))
  4. Format as text, call COMPACT_PROMPT via OpenAI SDK
  5. updateMessage(req, { messageId, summary, summaryTokenCount })
  ↓
Response: { message: "Compacted N messages" }
  ↓
[TODO: Toast notification to user]
```

### 3.3 Files Changed

| File | Change |
|------|--------|
| `api/server/controllers/agents/client.js` | AgentClient constructor (auto_compact init), summarizeMessages() |
| `api/app/clients/BaseClient.js` | Proactive threshold check in handleContextStrategy |
| `api/app/clients/prompts/summaryPrompts.js` | COMPACT_PROMPT template |
| `api/server/routes/convos.js` | POST /:conversationId/compact endpoint |
| `client/src/components/SidePanel/Agents/Advanced/AutoCompact.tsx` | Toggle + threshold UI |
| `client/src/components/SidePanel/Agents/Advanced/AdvancedPanel.tsx` | Renders AutoCompact, clearErrors |
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | Payload includes auto_compact, agent_id fallback |
| `client/src/components/SidePanel/Agents/AgentSelect.tsx` | Seeds defaults, handles number/boolean fields |
| `client/src/hooks/Messages/useSubmitMessage.ts` | /compact interception |
| `client/src/data-provider/mutations.ts` | useCompactConversation mutation |
| `packages/data-provider/src/api-endpoints.ts` | compactConversation endpoint |
| `packages/data-provider/src/data-service.ts` | compactConversation data service |
| `packages/data-provider/src/schemas.ts` | defaultAgentFormValues: auto_compact, compact_threshold |
| `packages/data-provider/src/types/assistants.ts` | Agent, AgentCreateParams, AgentUpdateParams types |
| `packages/api/src/agents/validation.ts` | Zod: auto_compact, compact_threshold |
| `packages/data-schemas/src/schema/agent.ts` | Mongoose: auto_compact, compact_threshold |
| `packages/data-schemas/src/types/agent.ts` | IAgent interface |
| `client/src/common/agents-types.ts` | AgentForm type |
| `client/src/locales/en/translation.json` | i18n keys |

### 3.4 Upstream Integration Points

| Integration | File | Line | Hook Type |
|-------------|------|------|-----------|
| Agent form submission | `AgentPanel.tsx` | 61, 410 | Modified — added fields to payload |
| Agent form loading | `AgentSelect.tsx` | 75, 123 | Modified — seed defaults, handle types |
| Advanced panel rendering | `AdvancedPanel.tsx` | 47 | Modified — added AutoCompact |
| Context strategy | `BaseClient.js` | 488 | Modified — proactive threshold |
| Agent constructor | `client.js` | 67 | Modified — reads auto_compact |
| Message interception | `useSubmitMessage.ts` | 26 | Modified — /compact detection |
| Conversation routes | `convos.js` | 324 | New route added |

---

## 4. Feature 3: File Browser Panel

### 4.1 Data Flow

```
librechat.yaml: interface.fileBrowser: true
  ↓
Config loaded by loadDefaultInterface() [packages/data-schemas/src/app/interface.ts]
  ↓
Passed to client via /api/v1/config → interfaceConfig.fileBrowser
  ↓
useSideNavLinks.ts checks interfaceConfig.fileBrowser
  ↓
If true: adds "File Browser" button to right-hand panel nav
  ↓
User clicks "File Browser"
  ↓
FileBrowserPanel.tsx renders
  ↓
On mount: GET /api/files/browse?path=/ → returns configured root directories
  ↓
Renders collapsible tree with root nodes
  ↓
User clicks folder → GET /api/files/browse?path=/storage/files → returns children
  ↓
Tree expands with children
  ↓
User clicks file → selected (highlighted), "Insert Path" button activates
  ↓
User clicks "Insert Path"
  ↓
Full path inserted into prompt textarea at cursor position
  ↓
User double-clicks file
  ↓
window.open('/api/files/browse/content?path=/storage/files/image.jpg')
  ↓
Backend serves file with Content-Type header
  ↓
Browser opens viewable types in tab, downloads others
```

### 4.2 New Files Required

| File | Purpose |
|------|---------|
| `client/src/components/SidePanel/FileBrowser/FileBrowserPanel.tsx` | Main panel component with tree view |
| `client/src/components/SidePanel/FileBrowser/FileTreeNode.tsx` | Individual tree node (folder/file) |
| `client/src/components/SidePanel/FileBrowser/index.ts` | Exports |
| `api/server/routes/files/browse.js` | GET /browse (directory listing), GET /browse/content (file serving) |

### 4.3 Modified Files

| File | Change |
|------|--------|
| `client/src/hooks/Nav/useSideNavLinks.ts` | Add File Browser link (gated by interfaceConfig.fileBrowser) |
| `packages/data-schemas/src/app/interface.ts` | Add `fileBrowser` to loadDefaultInterface |
| `api/server/routes/files/index.js` | Register browse routes |
| `client/src/locales/en/translation.json` | i18n keys for panel title, button label |

### 4.4 Backend API

**GET /api/files/browse?path=...**
- Auth: requireJwtAuth
- Validates path is within configured `interface.fileBrowserPaths` from librechat.yaml
- Returns: `{ entries: [{ name, type: 'file'|'directory', size, modified }] }`
- Error: 403 if path outside allowed directories, 404 if path doesn't exist

**GET /api/files/browse/content?path=...**
- Auth: requireJwtAuth
- Validates path is within allowed directories
- Serves raw file content with Content-Type from mime lookup
- Viewable types: Content-Disposition inline
- Other types: Content-Disposition attachment

### 4.5 Upstream Integration Points

| Integration | File | Line | Hook Type |
|-------------|------|------|-----------|
| Panel registration | `useSideNavLinks.ts` | ~150 | Modified — new link |
| Config loading | `interface.ts` | ~54 | Modified — new boolean |
| File routes | `files/index.js` | ~50 | Modified — new sub-router |

---

## 5. Infrastructure Changes

### 5.1 Dockerfile

```
COPY . .    ← **/dist excluded via .dockerignore
  ↓
npm run frontend   ← builds: data-provider → data-schemas → api → client
  ↓
npm prune --production
```

Key: `**/dist` in `.dockerignore` ensures all TypeScript packages build from source inside the container. No stale compiled output from the host.

### 5.2 Container Additions

- `bash` and `openssh-client` installed in container image (for MCP shell/git tools)

---

## 6. Component Inventory

| File | Feature |
|------|---------|
| `MCPServerCard.tsx` | F1 |
| `store/mcp.ts` | F1 |
| `useMCPSelect.ts` | F1 |
| `useNewConvo.ts` | F1 |
| `context.ts` | F1 + F2 |
| `client.js (AgentClient)` | F2 |
| `BaseClient.js` | F2 |
| `summaryPrompts.js` | F2 |
| `convos.js` | F2 |
| `AutoCompact.tsx` | F2 |
| `AdvancedPanel.tsx` | F2 |
| `AgentPanel.tsx` | F2 |
| `AgentSelect.tsx` | F2 |
| `useSubmitMessage.ts` | F2 |
| `mutations.ts` | F2 |
| `api-endpoints.ts` | F2 |
| `data-service.ts` | F2 |
| `schemas.ts` | F2 |
| `assistants.ts (types)` | F2 |
| `validation.ts` | F2 |
| `agent.ts (schema)` | F2 |
| `agent.ts (types)` | F2 |
| `agents-types.ts` | F2 |
| `translation.json` | F2 + F3 |
| `Dockerfile` | Infra |
| `.dockerignore` | Infra |
| `FileBrowserPanel.tsx` | F3 (new) |
| `FileTreeNode.tsx` | F3 (new) |
| `browse.js` | F3 (new) |
| `useSideNavLinks.ts` | F3 |
| `interface.ts` | F3 |
| `files/index.js` | F3 |
