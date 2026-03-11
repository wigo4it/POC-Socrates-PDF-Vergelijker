function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
    screenshotScale: parseNumber(process.env.SCREENSHOT_SCALE, 2.0),
    pixelmatchThreshold: parseNumber(process.env.PIXELMATCH_THRESHOLD, 0.1),
    maxAiPages: Math.max(1, Math.floor(parseNumber(process.env.MAX_AI_PAGES, 3))),
    textDiffSnippetChars: Math.max(200, Math.floor(parseNumber(process.env.TEXT_DIFF_SNIPPET_CHARS, 2000))),
    aiMaxTokens: Math.max(256, Math.floor(parseNumber(process.env.AI_MAX_TOKENS, 1500))),
    aiTimeoutMs: Math.max(1000, Math.floor(parseNumber(process.env.AI_TIMEOUT_MS, 30000))),
    reportFileName: process.env.REPORT_FILE_NAME || 'comparison_report.json',
};
