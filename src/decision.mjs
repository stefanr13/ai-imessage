import { generateWithOllama, parseJsonResponse } from "./ollama-client.mjs";

export const DEFAULT_MODEL = process.env.GEMMA_MODEL || "gemma4:12b";
const DEFAULT_MAX_VISIBLE_MESSAGES = Number(process.env.MAX_VISIBLE_MESSAGES || 12);
const DEFAULT_MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 1200);
const DEFAULT_MAX_STYLE_EXAMPLES = Number(process.env.MAX_STYLE_EXAMPLES || 6);
const DEFAULT_MAX_POSITIVE_EXAMPLES = Number(process.env.MAX_POSITIVE_EXAMPLES || 10);
const DEFAULT_MAX_NEGATIVE_EXAMPLES = Number(process.env.MAX_NEGATIVE_EXAMPLES || 10);

const SYSTEM = `You are a local message-assistant policy engine.
Return strict JSON only.
Return exactly these keys: action, replyText, matchedRule, reason.
Do not include thoughts, analysis, markdown, or extra fields.
Never invent message content.
Only choose "reply" when an explicit rule matches the latest incoming message.
Choose "ask_user" for ambiguous, risky, emotional, financial, legal, medical, credential, relationship, or commitment-making cases.
Choose "ignore" when there is no new actionable incoming message.`;

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["reply", "ask_user", "ignore"] },
    replyText: { anyOf: [{ type: "string" }, { type: "null" }] },
    matchedRule: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason: { type: "string" },
  },
  required: ["action", "replyText", "matchedRule", "reason"],
  additionalProperties: false,
};

function trimText(text, maxChars = DEFAULT_MAX_MESSAGE_CHARS) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}[trimmed ${text.length - maxChars} chars]`;
}

export function compactVisibleConversation(visible, maxMessages = DEFAULT_MAX_VISIBLE_MESSAGES) {
  const messages = Array.isArray(visible.messages) ? visible.messages : [];
  const compactMessages = messages.slice(-maxMessages).map((message) => ({
    direction: message.direction,
    text: trimText(message.text),
  }));
  const latestOutgoingIndex = compactMessages.findLastIndex((message) => message.direction === "outgoing");
  const incomingSinceLastOutgoing = compactMessages
    .slice(latestOutgoingIndex + 1)
    .filter((message) => message.direction === "incoming" && String(message.text || "").trim());
  return {
    conversationTitle: visible.conversationTitle || null,
    messages: compactMessages,
    incomingSinceLastOutgoing,
  };
}

export function validateDecision(decision) {
  const allowedActions = new Set(["reply", "ask_user", "ignore"]);
  const allowedKeys = new Set(["action", "replyText", "matchedRule", "reason"]);
  if (!decision || typeof decision !== "object") {
    throw new Error("Decision must be a JSON object.");
  }
  for (const key of Object.keys(decision)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected decision field: ${key}`);
    }
  }
  if (!allowedActions.has(decision.action)) {
    throw new Error(`Invalid decision action: ${decision.action}`);
  }
  if (decision.action === "reply" && typeof decision.replyText !== "string") {
    throw new Error("Reply decisions must include a string replyText.");
  }
  if (decision.action !== "reply" && decision.replyText !== null) {
    throw new Error("Non-reply decisions must use replyText: null.");
  }
  return decision;
}

export async function decideNextAction({ contact, visible }) {
  const compactVisible = compactVisibleConversation(visible);
  const prompt = JSON.stringify(
    {
      task: "Decide whether to reply in this Messages conversation.",
      contact: {
        displayName: contact.displayName,
        conversationTitle: contact.conversationTitle,
        autoRules: contact.autoRules || [],
        styleProfile: contact.styleProfile || null,
      },
      visibleConversationTitle: compactVisible.conversationTitle,
      latestMessages: compactVisible.messages,
      incomingSinceLastOutgoing: compactVisible.incomingSinceLastOutgoing,
      allowedActions: ["reply", "ask_user", "ignore"],
      requiredOutput: {
        action: "reply | ask_user | ignore",
        replyText: "string or null",
        matchedRule: "string or null",
        reason: "short string",
      },
    },
    null,
    2
  );

  const result = await generateWithOllama({
    model: DEFAULT_MODEL,
    system: SYSTEM,
    prompt,
    format: DECISION_SCHEMA,
    options: {
      temperature: 0,
      num_ctx: 8192,
    },
  });

  return {
    decision: validateDecision(parseJsonResponse(result.text)),
    usage: result.usage,
    model: result.model,
    promptStats: {
      promptChars: prompt.length,
      messageCount: compactVisible.messages.length,
    },
    rawText: result.text,
  };
}

export function deterministicRuleDecision({ contact, visible }) {
  const latestMessage = [...(visible.messages || [])].reverse().find((message) => {
    return typeof message.text === "string" && message.text.trim();
  });

  if (!latestMessage) {
    return { action: "ignore", replyText: null, matchedRule: null, reason: "No visible message text." };
  }

  if (latestMessage.direction === "outgoing") {
    return { action: "ignore", replyText: null, matchedRule: null, reason: "Latest visible message is outgoing." };
  }

  if (latestMessage.direction !== "incoming") {
    return {
      action: "ask_user",
      replyText: null,
      matchedRule: null,
      reason: "Latest visible message direction is unknown.",
    };
  }

  for (const rule of contact.autoRules || []) {
    if (latestMessage.text.trim() === rule.whenLatestIncomingEquals) {
      return {
        action: "reply",
        replyText: rule.reply,
        matchedRule: rule.name,
        reason: "Latest incoming message exactly matched configured rule.",
      };
    }
  }

  return {
    action: "ask_user",
    replyText: null,
    matchedRule: null,
    reason: "Latest incoming message did not match a deterministic auto-rule.",
  };
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    shouldReply: { type: "boolean" },
    replyText: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason: { type: "string" },
  },
  required: ["shouldReply", "replyText", "reason"],
  additionalProperties: false,
};

const DRAFT_SYSTEM = `You draft text-message replies for the user.
Return strict JSON only with exactly these keys: shouldReply, replyText, reason.
Write in a casual concise texting style that sounds like a real human text, not an assistant.
When there are multiple incoming messages after the user's latest outgoing message, reply to that whole batch as one conversation turn instead of only the final bubble.
Concise does not mean incomplete. Address each substantive item, offer, question, or update in the incoming batch with one natural message.
Use conversation memory only for the user's voice, relationship context, nicknames, and boundaries.
Do not copy old replies unless the same phrase is naturally appropriate.
Avoid tidy summaries, polished recap language, and obvious AI phrasing.
Do not use em dashes, en dashes, or hyphen separators unless the user's current style policy explicitly allows them.
Never claim the user has done something they have not done.
If the message requires private knowledge, a commitment, money, legal, medical, credentials, conflict, or high-stakes judgment, set shouldReply false and replyText null.`;

function containsDash(value) {
  return /[-\u2010-\u2015]/u.test(String(value || ""));
}

function filterPolicyList(values, policy) {
  const list = Array.isArray(values) ? values : [];
  if (!policy?.forbidDashCharacters) return list.slice(0, 10);
  return list.filter((value) => !containsDash(value)).slice(0, 10);
}

function filterPolicyText(value, policy) {
  const text = String(value || "");
  if (policy?.forbidDashCharacters && containsDash(text)) return "";
  return text;
}

function compactMemoryContext(memoryContext, policy = null) {
  if (!memoryContext) return null;
  return {
    profileUpdatedAt: memoryContext.profileUpdatedAt || null,
    configuredStyleProfile: memoryContext.contactStyleProfile || null,
    profile: memoryContext.profile
      ? {
          relationshipSummary: memoryContext.profile.relationshipSummary || "",
          toneSummary: memoryContext.profile.toneSummary || "",
          userVoiceRules: filterPolicyList(memoryContext.profile.userVoiceRules, policy),
          typicalReplyLength: filterPolicyText(memoryContext.profile.typicalReplyLength, policy),
          emojiStyle: filterPolicyText(memoryContext.profile.emojiStyle, policy),
          punctuationStyle: filterPolicyText(memoryContext.profile.punctuationStyle, policy),
          nicknamesAndPetNames: filterPolicyList(memoryContext.profile.nicknamesAndPetNames, policy),
          recurringTopics: filterPolicyList(memoryContext.profile.recurringTopics, policy),
          insideJokesOrReferences: filterPolicyList(memoryContext.profile.insideJokesOrReferences, policy),
          doNotImitate: filterPolicyList(memoryContext.profile.doNotImitate, policy),
          askUserBefore: filterPolicyList(memoryContext.profile.askUserBefore, policy),
          confidence: memoryContext.profile.confidence || "low",
        }
      : null,
    styleExamples: (memoryContext.styleExamples || [])
      .filter((example) => !(policy?.forbidDashCharacters && containsDash(example.replyText)))
      .slice(0, DEFAULT_MAX_STYLE_EXAMPLES)
      .map((example) => ({
        incoming: example.incoming.map((message) => ({
          direction: message.direction,
          text: trimText(message.text, 400),
        })),
        userReply: trimText(example.replyText, 500),
      })),
  };
}

function compactContrastiveExamples(contact = null, policy = null) {
  const examples = contact?.styleExamples || {};
  const positiveLimit = Number(policy?.maxPositiveExamples || DEFAULT_MAX_POSITIVE_EXAMPLES);
  const negativeLimit = Number(policy?.maxNegativeExamples || DEFAULT_MAX_NEGATIVE_EXAMPLES);
  return {
    writeLikeThis: (examples.positive || []).slice(0, positiveLimit).map((example) => ({
      incoming: (example.incoming || []).map((text) => trimText(text, 300)),
      reply: trimText(example.reply, 300),
      why: trimText(example.why, 220),
    })),
    doNotWriteLikeThis: (examples.negative || []).slice(0, negativeLimit).map((example) => ({
      incoming: (example.incoming || []).map((text) => trimText(text, 300)),
      badReply: trimText(example.badReply, 360),
      whyBad: trimText(example.whyBad, 260),
    })),
  };
}

export async function draftReply({ visible, contact = null, memoryContext = null }) {
  const compactVisible = compactVisibleConversation(visible);
  const policy = contact?.draftPolicy || null;
  const compactMemory = compactMemoryContext(memoryContext, policy);
  const contrastiveExamples = compactContrastiveExamples(contact, policy);
  const maxAttempts = Number(process.env.DRAFT_STYLE_ATTEMPTS || 3);
  const attempts = [];
  let retryFeedback = null;
  let finalResult = null;
  let finalDecision = null;
  let finalPrompt = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildDraftPrompt({ compactVisible, contact, compactMemory, contrastiveExamples, retryFeedback });
    finalPrompt = prompt;
    const result = await generateWithOllama({
      model: DEFAULT_MODEL,
      system: DRAFT_SYSTEM,
      prompt,
      format: DRAFT_SCHEMA,
      options: {
        temperature: attempt === 1 ? 0.25 : 0.1,
        num_ctx: 8192,
      },
    });
    finalResult = result;
    const decision = validateDraftResult(parseJsonResponse(result.text));
    const violations = draftPolicyViolations(decision, contact?.draftPolicy, compactVisible);
    attempts.push({
      attempt,
      replyText: decision.replyText,
      shouldReply: decision.shouldReply,
      violations,
      usage: result.usage,
    });
    if (!violations.length) {
      finalDecision = decision;
      break;
    }
    finalDecision = blockDraftForViolations(violations);
    retryFeedback = {
      rejectedReply: decision.replyText,
      violations,
      instruction:
        "Rewrite as a short, human text in the user's real style. Address every listed violation and each substantive incoming item. Do not use any dash characters. If you cannot do that naturally, return shouldReply false.",
    };
  }

  return {
    draft: finalDecision,
    usage: finalResult.usage,
    model: finalResult.model,
    promptStats: {
      promptChars: finalPrompt.length,
      messageCount: compactVisible.messages.length,
      memoryExamples: compactMemory?.styleExamples?.length || 0,
      positiveExamples: contrastiveExamples.writeLikeThis.length,
      negativeExamples: contrastiveExamples.doNotWriteLikeThis.length,
      hasMemoryProfile: Boolean(compactMemory?.profile),
      attempts: attempts.length,
      styleViolations: attempts.at(-1)?.violations || [],
    },
    rawText: finalResult.text,
  };
}

function buildDraftPrompt({ compactVisible, contact, compactMemory, contrastiveExamples, retryFeedback = null }) {
  return JSON.stringify(
    {
      task: "Draft the reply the user might send. Do not send it.",
      contact: contact
        ? {
            displayName: contact.displayName,
            relationship: contact.relationship || null,
            styleProfile: contact.styleProfile || null,
            contextFacts: contact.contextFacts || null,
          }
        : null,
      memoryContext: compactMemory,
      contrastiveStyleExamples: {
        instruction:
          "Imitate only writeLikeThis examples. Never imitate doNotWriteLikeThis examples; use whyBad to avoid those failure modes.",
        ...contrastiveExamples,
      },
      visibleConversationTitle: compactVisible.conversationTitle,
      latestMessages: compactVisible.messages,
      incomingSinceLastOutgoing: compactVisible.incomingSinceLastOutgoing,
      instruction:
        "The reply must respond to the incomingSinceLastOutgoing batch as the current conversation turn. Use memoryContext to match voice and boundaries, but prioritize the current messages. Avoid sounding like ChatGPT. For close chats, prefer a short imperfect human text that still addresses the actual points.",
      hardStyleRules: [
        "Do not use em dashes, en dashes, or hyphen separators.",
        "Do not use tidy recap phrases like 'this whole sequence' or 'the audacity'.",
        "Do not summarize every detail just to prove you read it, but do not ignore substantive incoming messages.",
        "If there is an offer, plan, question, or personal update, acknowledge it directly.",
        "Prefer one short natural complete reply over a one-note punchline.",
      ],
      draftPolicy: contact?.draftPolicy || null,
      retryFeedback,
      requiredOutput: {
        shouldReply: "boolean",
        replyText: "string or null",
        reason: "short string",
      },
    },
    null,
    2
  );
}

function validateDraftResult(decision) {
  if (!decision || typeof decision !== "object") {
    throw new Error("Draft result must be a JSON object.");
  }
  if (typeof decision.shouldReply !== "boolean") {
    throw new Error("Draft result must include boolean shouldReply.");
  }
  if (decision.shouldReply && typeof decision.replyText !== "string") {
    throw new Error("Draft reply requires replyText.");
  }
  if (!decision.shouldReply && decision.replyText !== null) {
    throw new Error("Non-reply draft must use replyText: null.");
  }
  return decision;
}

function safeRegex(pattern) {
  try {
    return new RegExp(String(pattern || ""), "i");
  } catch {
    return null;
  }
}

function incomingBatchText(compactVisible = null) {
  return (compactVisible?.incomingSinceLastOutgoing || [])
    .map((message) => String(message.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

export function draftPolicyViolations(decision, policy = null, compactVisible = null) {
  if (!decision?.shouldReply || !decision.replyText || !policy) return [];

  const reply = String(decision.replyText);
  const violations = [];
  if (policy.maxAutoSendChars && reply.length > Number(policy.maxAutoSendChars)) {
    violations.push(`reply too long (${reply.length} chars)`);
  }
  if (policy.forbidDashCharacters && /[-\u2010-\u2015]/u.test(reply)) {
    violations.push("contains dash character");
  }
  for (const phrase of policy.forbiddenPhrases || []) {
    if (phrase && reply.toLowerCase().includes(String(phrase).toLowerCase())) {
      violations.push(`forbidden phrase: ${phrase}`);
    }
  }
  const incomingText = incomingBatchText(compactVisible);
  for (const rule of policy.coverageRules || []) {
    const incomingRegex = safeRegex(rule.incomingPattern);
    const replyRegex = safeRegex(rule.replyPattern);
    if (!incomingRegex || !replyRegex) continue;
    if (incomingRegex.test(incomingText) && !replyRegex.test(reply)) {
      violations.push(rule.reason || `coverage rule failed: ${rule.name || rule.incomingPattern}`);
    }
  }
  for (const excluded of policy.excludedStyleReplies || []) {
    if (excluded && reply.trim().toLowerCase() === String(excluded).trim().toLowerCase()) {
      violations.push("matches excluded AI-style reply");
    }
  }
  return violations;
}

function blockDraftForViolations(violations) {
  return {
    shouldReply: false,
    replyText: null,
    reason: `Draft blocked by style policy: ${violations.join("; ")}.`,
  };
}

export function applyDraftPolicy(decision, policy = null) {
  const violations = draftPolicyViolations(decision, policy);
  return violations.length ? blockDraftForViolations(violations) : decision;
}
