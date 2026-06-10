import { DEFAULT_MODEL } from "./decision.mjs";
import { generateWithOllama, parseJsonResponse } from "./ollama-client.mjs";
import { loadConversationProfile, loadProfileSeed, saveConversationProfile } from "./memory-store.mjs";

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    relationshipSummary: { type: "string", maxLength: 240 },
    toneSummary: { type: "string", maxLength: 280 },
    userVoiceRules: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 180 },
    },
    typicalReplyLength: { type: "string", maxLength: 180 },
    emojiStyle: { type: "string", maxLength: 180 },
    punctuationStyle: { type: "string", maxLength: 180 },
    nicknamesAndPetNames: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 120 },
    },
    recurringTopics: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 140 },
    },
    insideJokesOrReferences: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 140 },
    },
    doNotImitate: {
      type: "array",
      maxItems: 10,
      items: { type: "string", maxLength: 180 },
    },
    askUserBefore: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 180 },
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
  },
  required: [
    "relationshipSummary",
    "toneSummary",
    "userVoiceRules",
    "typicalReplyLength",
    "emojiStyle",
    "punctuationStyle",
    "nicknamesAndPetNames",
    "recurringTopics",
    "insideJokesOrReferences",
    "doNotImitate",
    "askUserBefore",
    "confidence",
  ],
  additionalProperties: false,
};

const PROFILE_SYSTEM = `You build a compact local style profile for a text-message assistant.
Return strict JSON only with exactly the requested keys.
Use only the provided conversation examples.
Capture how the user writes to this specific person, not generic texting advice.
Do not invent facts, relationships, commitments, or private context.
Add low confidence when evidence is thin or mostly testing messages.
Keep every string concise. Keep arrays short and high-signal.`;

const PROFILE_STRING_FIELDS = [
  "relationshipSummary",
  "toneSummary",
  "typicalReplyLength",
  "emojiStyle",
  "punctuationStyle",
];

function boundedNumber(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function trimText(value, maxChars = 800) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}[trimmed ${text.length - maxChars} chars]`;
}

function removeDashCharacters(value) {
  return String(value || "")
    .replace(/(\d)\s*[-\u2010-\u2015]\s*(\d)/gu, "$1 to $2")
    .replace(/[-\u2010-\u2015]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactConfiguredExamples(examples, { positiveLimit = 6, negativeLimit = 6 } = {}) {
  const positive = Array.isArray(examples?.positive) ? examples.positive : [];
  const negative = Array.isArray(examples?.negative) ? examples.negative : [];
  return {
    writeLikeThis: positive.slice(0, positiveLimit).map((example) => ({
      incoming: Array.isArray(example.incoming) ? example.incoming.map((text) => trimText(text, 180)) : [],
      reply: trimText(example.reply, 180),
      why: trimText(example.why, 160),
    })),
    doNotWriteLikeThis: negative.slice(0, negativeLimit).map((example) => ({
      incoming: Array.isArray(example.incoming) ? example.incoming.map((text) => trimText(text, 180)) : [],
      badReply: trimText(example.badReply, 220),
      whyBad: trimText(example.whyBad, 180),
    })),
  };
}

function compactContact(contact = {}, slug, window) {
  const policy = contact.draftPolicy || {};
  const examples = compactConfiguredExamples(contact.styleExamples, {
    positiveLimit: window.positiveLimit,
    negativeLimit: window.negativeLimit,
  });
  return {
    displayName: contact.displayName || slug,
    relationship: contact.relationship || null,
    configuredStyleProfile: contact.styleProfile ? trimText(contact.styleProfile, 500) : null,
    styleGuardrails: {
      forbidDashCharacters: Boolean(policy.forbidDashCharacters),
      maxAutoSendChars: policy.maxAutoSendChars || null,
      lowConfidenceAutoSendMaxChars: policy.lowConfidenceAutoSendMaxChars || null,
      forbiddenPhrases: Array.isArray(policy.forbiddenPhrases)
        ? policy.forbiddenPhrases.slice(0, 12).map((phrase) => trimText(phrase, 80))
        : [],
    },
    configuredExamples: examples,
  };
}

function compactSeed(seed, { messageLimit, exampleLimit } = {}) {
  messageLimit = boundedNumber(messageLimit || process.env.PROFILE_COMPACT_MESSAGES, 100, { max: 140 });
  exampleLimit = boundedNumber(exampleLimit || process.env.PROFILE_COMPACT_EXAMPLES, 20, { max: 30 });
  return {
    recentMessages: seed.messages.slice(-messageLimit).map((message) => ({
      direction: message.direction,
      sender: message.sender,
      text: trimText(message.text, 320),
    })),
    styleExamples: seed.examples.slice(0, exampleLimit).map((example) => ({
      incoming: example.incoming.map((message) => ({
        direction: message.direction,
        text: trimText(message.text, 400),
      })),
      userReply: trimText(example.replyText, 500),
    })),
  };
}

function normalizeStringList(value, { maxItems = 8, maxChars = 180 } = {}) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  return source
    .map((entry) => trimText(entry, maxChars).trim())
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(2));
}

function computeLocalStyleStats(seed) {
  const outgoing = seed.messages
    .filter((message) => message.direction === "outgoing")
    .map((message) => String(message.text || "").trim())
    .filter(Boolean);
  const lengths = outgoing.map((text) => text.length);
  const wordCounts = outgoing.map((text) => text.split(/\s+/).filter(Boolean).length);
  const total = outgoing.length;
  return {
    outgoingReplyCount: total,
    averageChars: total ? Math.round(lengths.reduce((sum, length) => sum + length, 0) / total) : 0,
    medianChars: Math.round(median(lengths)),
    oneWordReplyRate: ratio(wordCounts.filter((count) => count <= 1).length, total),
    shortReplyUnder40CharsRate: ratio(lengths.filter((length) => length <= 40).length, total),
    startsLowercaseRate: ratio(outgoing.filter((text) => /^[a-z]/.test(text)).length, total),
    startsUppercaseRate: ratio(outgoing.filter((text) => /^[A-Z]/.test(text)).length, total),
    endsWithPeriodRate: ratio(outgoing.filter((text) => /\.$/.test(text)).length, total),
    endsWithExclamationRate: ratio(outgoing.filter((text) => /!$/.test(text)).length, total),
    questionReplyRate: ratio(outgoing.filter((text) => /\?$/.test(text)).length, total),
    emojiReplyRate: ratio(outgoing.filter((text) => /\p{Extended_Pictographic}/u.test(text)).length, total),
  };
}

function normalizeProfile(profile) {
  const normalized = {};
  for (const key of PROFILE_STRING_FIELDS) {
    normalized[key] = trimText(profile?.[key] || "", 280).trim();
  }
  normalized.userVoiceRules = normalizeStringList(profile?.userVoiceRules, { maxItems: 8, maxChars: 180 });
  normalized.nicknamesAndPetNames = normalizeStringList(profile?.nicknamesAndPetNames, { maxItems: 8, maxChars: 120 });
  normalized.recurringTopics = normalizeStringList(profile?.recurringTopics, { maxItems: 8, maxChars: 140 });
  normalized.insideJokesOrReferences = normalizeStringList(profile?.insideJokesOrReferences, { maxItems: 8, maxChars: 140 });
  normalized.doNotImitate = normalizeStringList(profile?.doNotImitate, { maxItems: 10, maxChars: 180 });
  normalized.askUserBefore = normalizeStringList(profile?.askUserBefore, { maxItems: 8, maxChars: 180 });
  normalized.confidence = ["low", "medium", "high"].includes(profile?.confidence) ? profile.confidence : "low";
  return normalized;
}

async function generateProfile({ prompt }) {
  const result = await generateWithOllama({
    model: DEFAULT_MODEL,
    system: PROFILE_SYSTEM,
    prompt,
    format: PROFILE_SCHEMA,
    options: {
      temperature: 0,
      num_ctx: boundedNumber(process.env.PROFILE_NUM_CTX, 8192, { min: 2048, max: 32768 }),
      num_predict: boundedNumber(process.env.PROFILE_NUM_PREDICT, 1536, { min: 512, max: 4096 }),
    },
    timeoutMs: boundedNumber(process.env.PROFILE_OLLAMA_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS, 90_000, {
      min: 10_000,
      max: 600_000,
    }),
  });
  const parsed = parseJsonResponse(result.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Profile must be a JSON object.");
  }
  return {
    result,
    profile: validateProfile(normalizeProfile(parsed)),
  };
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("Profile must be a JSON object.");
  for (const key of PROFILE_SCHEMA.required) {
    if (!(key in profile)) throw new Error(`Missing profile field: ${key}`);
  }
  for (const key of [
    "userVoiceRules",
    "nicknamesAndPetNames",
    "recurringTopics",
    "insideJokesOrReferences",
    "doNotImitate",
    "askUserBefore",
  ]) {
    if (!Array.isArray(profile[key])) throw new Error(`Profile field must be an array: ${key}`);
  }
  if (!["low", "medium", "high"].includes(profile.confidence)) {
    throw new Error(`Invalid profile confidence: ${profile.confidence}`);
  }
  return profile;
}

function capProfileConfidence(profile, seed) {
  const capped = { ...profile };
  if (seed.examples.length < 3 || seed.messages.length < 12) {
    capped.confidence = "low";
  } else if ((seed.examples.length < 8 || seed.messages.length < 40) && capped.confidence === "high") {
    capped.confidence = "medium";
  }
  return capped;
}

function applyPolicyBackstops(profile, contact = {}) {
  const policy = contact.draftPolicy || {};
  const baseProfile = policy.forbidDashCharacters
    ? {
        ...profile,
        relationshipSummary: removeDashCharacters(profile.relationshipSummary),
        toneSummary: removeDashCharacters(profile.toneSummary),
        typicalReplyLength: removeDashCharacters(profile.typicalReplyLength),
        emojiStyle: removeDashCharacters(profile.emojiStyle),
        punctuationStyle: removeDashCharacters(profile.punctuationStyle),
        userVoiceRules: profile.userVoiceRules.map(removeDashCharacters),
        nicknamesAndPetNames: profile.nicknamesAndPetNames.map(removeDashCharacters),
        recurringTopics: profile.recurringTopics.map(removeDashCharacters),
        insideJokesOrReferences: profile.insideJokesOrReferences.map(removeDashCharacters),
        doNotImitate: profile.doNotImitate.map(removeDashCharacters),
        askUserBefore: profile.askUserBefore.map(removeDashCharacters),
      }
    : profile;
  const doNotImitate = [...baseProfile.doNotImitate];
  const userVoiceRules = [...baseProfile.userVoiceRules];
  if (policy.forbidDashCharacters) {
    doNotImitate.push("Do not use dash characters, em dashes, hyphen separators, or dash emoticons.");
  }
  if (Array.isArray(policy.forbiddenPhrases) && policy.forbiddenPhrases.length) {
    doNotImitate.push("Avoid configured AI sounding phrases and stock internet reactions.");
  }
  if ((policy.forbiddenPhrases || []).some((phrase) => String(phrase).toLowerCase() === "hahaha")) {
    const laughterRule = "Do not add Hahaha or fake laughter unless the user explicitly would.";
    doNotImitate.push(laughterRule);
    userVoiceRules.push("Avoid forced laughter; warmth can be direct without Hahaha.");
  }
  if (contact.styleProfile) {
    userVoiceRules.push("Prefer short, specific, casual replies over polished summaries.");
  }
  return {
    ...baseProfile,
    userVoiceRules: normalizeStringList(userVoiceRules, { maxItems: 8, maxChars: 180 }),
    doNotImitate: normalizeStringList(doNotImitate, { maxItems: 10, maxChars: 180 }),
  };
}

function applyObservedStatsBackstops(profile, stats) {
  let userVoiceRules = [...profile.userVoiceRules];
  let punctuationStyle = profile.punctuationStyle;

  if (stats.shortReplyUnder40CharsRate > 0.45) {
    userVoiceRules = userVoiceRules.filter((rule) => !/\bbrief\b|one or one word|one or two words|1 to 2/i.test(rule));
    userVoiceRules.unshift("Keep replies short, often one phrase or one to two words.");
  }

  if (stats.startsLowercaseRate < 0.4) {
    userVoiceRules = userVoiceRules.filter((rule) => !/\blowercase\b|\blower case\b|all[- ]?lower/i.test(rule));
    userVoiceRules.push("Use natural capitalization from the user's examples; do not force all lowercase texting.");
  }

  if (stats.endsWithPeriodRate > 0.1 && /\bno periods?\b|never.*period|without periods?/i.test(punctuationStyle)) {
    punctuationStyle = "Minimal punctuation; often no final period, but short punchlines may use a period.";
  }
  if (stats.endsWithPeriodRate > 0.1) {
    userVoiceRules = userVoiceRules.filter(
      (rule) =>
        !/\bno punctuation\b|\bno periods?\b|without punctuation|without periods?|end of sentences|punctuation sparingly|period is okay/i.test(
          rule
        )
    );
    userVoiceRules.push("Use punctuation sparingly; a period is okay for short punchlines.");
  }

  return {
    ...profile,
    punctuationStyle,
    userVoiceRules: normalizeStringList(userVoiceRules, { maxItems: 8, maxChars: 180 }),
    doNotImitate: normalizeStringList(profile.doNotImitate, { maxItems: 10, maxChars: 180 }),
  };
}

export async function refreshConversationProfile({ slug, contact = {}, force = false } = {}) {
  const seed = await loadProfileSeed({
    slug,
    contact,
    messageLimit: boundedNumber(process.env.PROFILE_MESSAGE_LIMIT, 140, { max: 240 }),
    exampleLimit: boundedNumber(process.env.PROFILE_EXAMPLE_LIMIT, 30, { max: 60 }),
  });
  const existing = await loadConversationProfile({ slug });
  if (!force && existing?.profile && seed.messages.length <= existing.sourceMessageCount) {
    return {
      refreshed: false,
      profile: existing.profile,
      model: existing.model,
      usage: existing.usage,
      sourceMessageCount: existing.sourceMessageCount,
      sourceExampleCount: existing.sourceExampleCount,
    };
  }

  if (!seed.messages.length) {
    throw new Error(`No stored messages for profile '${slug}'. Ingest a visible conversation first.`);
  }
  const localStyleStats = computeLocalStyleStats(seed);

  const evidenceWindows = [
    {
      messageLimit: boundedNumber(process.env.PROFILE_COMPACT_MESSAGES, 100, { max: 140 }),
      exampleLimit: boundedNumber(process.env.PROFILE_COMPACT_EXAMPLES, 20, { max: 30 }),
      positiveLimit: boundedNumber(process.env.PROFILE_CONTACT_POSITIVE_EXAMPLES, 8, { max: 10 }),
      negativeLimit: boundedNumber(process.env.PROFILE_CONTACT_NEGATIVE_EXAMPLES, 8, { max: 10 }),
    },
    { messageLimit: 60, exampleLimit: 12, positiveLimit: 6, negativeLimit: 6 },
    { messageLimit: 35, exampleLimit: 7, positiveLimit: 4, negativeLimit: 4 },
  ];
  let generated = null;
  let lastError = null;
  for (const window of evidenceWindows) {
    const compact = compactSeed(seed, window);
    const prompt = JSON.stringify(
      {
        task: "Build or update the conversation-specific style profile.",
        contact: compactContact(contact, slug, window),
        existingProfile: existing?.profile || null,
        localStyleStats,
        evidence: compact,
        outputRules: [
          "Favor the user's actual outgoing replies and extracted incoming-to-reply examples over guesses.",
          "Use localStyleStats to avoid overgeneralizing casing, punctuation, emoji frequency, or reply length.",
          "Use configured writeLikeThis/doNotWriteLikeThis examples only as style guardrails, not as transcript facts.",
          "Capture patterns the live drafter can use without seeing the full transcript.",
          "Identify nicknames, humor style, emoji habits, and reply length.",
          "Avoid polished assistant phrasing, broad recaps, and over-addressing every incoming message.",
          "Keep all fields compact.",
          "Mark confidence low if the evidence is thin or mostly artificial testing.",
          "Do not include long raw transcripts in the profile.",
        ],
      },
      null,
      2
    );
    try {
      generated = await generateProfile({ prompt });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!generated) throw lastError;

  const result = generated.result;
  const profile = applyObservedStatsBackstops(
    applyPolicyBackstops(capProfileConfidence(generated.profile, seed), contact),
    localStyleStats
  );
  await saveConversationProfile({
    slug,
    profile,
    model: result.model,
    usage: result.usage,
    sourceMessageCount: seed.messages.length,
    sourceExampleCount: seed.examples.length,
  });

  return {
    refreshed: true,
    profile,
    model: result.model,
    usage: result.usage,
    sourceMessageCount: seed.messages.length,
    sourceExampleCount: seed.examples.length,
  };
}
