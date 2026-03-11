require('dotenv').config();
const { PDFParse } = require('pdf-parse');
const pixelmatch = require('pixelmatch').default;
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const Diff = require('diff');
const config = require('./src/config');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const EXIT_CODES = {
    PASS: 0,
    WARN: 2,
    FAIL: 3,
    ERROR: 4,
};

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
    ]);
}

function parseClaudeJson(rawText) {
    const trimmed = rawText.trim();
    const withoutFence = trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(withoutFence);

    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Claude response JSON is not an object.');
    }
    if (typeof parsed.isAcceptable !== 'boolean') {
        throw new Error('Claude response is missing boolean field "isAcceptable".');
    }
    if (typeof parsed.reasoning !== 'string') {
        throw new Error('Claude response is missing string field "reasoning".');
    }
    if (!Array.isArray(parsed.pages)) {
        throw new Error('Claude response is missing array field "pages".');
    }

    return parsed;
}

function evaluatePolicy(report) {
    const reasons = [];
    let status = 'PASS';

    if (report.visualDiff.pageCountMismatch) {
        reasons.push('Page count mismatch between compared PDFs.');
        status = 'FAIL';
    }

    if (report.visualDiff.dimensionMismatches.length > 0) {
        reasons.push(`Dimension mismatch on pages: ${report.visualDiff.dimensionMismatches.join(', ')}.`);
        status = 'FAIL';
    }

    if (report.ai.status === 'VALID' && report.ai.result && report.ai.result.isAcceptable === false) {
        reasons.push('AI marked comparison as not acceptable.');
        status = 'FAIL';
    }

    if (status !== 'FAIL' && report.ai.status !== 'VALID') {
        reasons.push(`AI verdict unavailable (${report.ai.status}).`);
        status = 'WARN';
    }

    if (reasons.length === 0) {
        reasons.push('All checks passed.');
    }

    return {
        status,
        reasons,
        exitCode: EXIT_CODES[status],
    };
}

function ensureOutputDir(outputDir) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
}

function validatePdfPath(pdfPath, label) {
    if (!pdfPath) {
        throw new Error(`${label} path is required.`);
    }
    if (!fs.existsSync(pdfPath)) {
        throw new Error(`${label} not found: ${pdfPath}`);
    }
    if (path.extname(pdfPath).toLowerCase() !== '.pdf') {
        throw new Error(`${label} must be a .pdf file: ${pdfPath}`);
    }
}

/**
 * Extracts text and screenshots from a PDF file.
 */
async function processPDF(pdfPath) {
    const dataBuffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(dataBuffer) });

    // Extract text
    const textResult = await parser.getText();

    // Render pages to screenshots (scale 2.0 for clarity)
    const screenshotResult = await parser.getScreenshot({ scale: config.screenshotScale });

    await parser.destroy();

    return {
        text: textResult.text,
        pages: screenshotResult.pages // Array of { data: Uint8Array, width, height, ... }
    };
}

/**
 * Compares text and returns a summary of changes.
 */
function compareText(text1, text2) {
    const changes = Diff.diffLines(text1, text2);
    const diffLines = [];
    let hasChanges = false;
    let changedLineCount = 0;

    changes.forEach((part) => {
        if (part.added || part.removed) {
            hasChanges = true;
            const prefix = part.added ? "+ " : "- ";
            const lines = part.value
                .split('\n')
                .filter((line) => line)
                .map((line) => `${prefix}${line}`);
            changedLineCount += lines.length;
            diffLines.push(...lines);
        }
    });

    const fullDiffSummary = diffLines.join('\n').trim();
    const snippet = fullDiffSummary.slice(0, config.textDiffSnippetChars);
    const truncatedChars = Math.max(0, fullDiffSummary.length - snippet.length);

    return {
        hasChanges,
        changedLineCount,
        diffSummary: fullDiffSummary,
        snippet,
        truncatedChars,
    };
}

/**
 * Interprets the comparison results using Claude by sending original images side-by-side.
 */
async function interpretWithClaude(totalDiffPixels, selectedPages, textDiff) {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.warn('\nNote: ANTHROPIC_API_KEY not found in .env. Skipping AI interpretation.');
        return {
            status: 'SKIPPED_NO_API_KEY',
            error: null,
            raw: null,
            result: null,
        };
    }

    console.log('\nRequesting AI interpretation from Claude (Direct Visual Comparison)...');

    const textDiffContext = textDiff.hasChanges
        ? `TEXTUAL CHANGES DETECTED:\n${textDiff.snippet}${textDiff.truncatedChars > 0 ? `... [truncated ${textDiff.truncatedChars} chars]` : ''}`
        : "NO TEXTUAL CHANGES DETECTED (The content is identical).";

    let rawResponseText = null;

    try {
        const messages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `You are a document comparison expert. I have two versions of a PDF.
                        
                        We are transitioning from one document engine to another. I need you to test wether the new engine produces the same output as the old engine. Minor changes in the documents are allowed, such as different line breaks, slightly different positioning etc. However, the contents of the documents should remain the same and we cannot have major visual disruptions. For instance, if a table is rendered slightly differently, it is acceptable. If a table is missing or has wrong values, it is not acceptable. A table that used to be on a single page and is now split over two pages is also not acceptable.

                        The documents are generated by an automated system, so minor differences are expected. However, we cannot have major visual disruptions.

                        ANALYSIS DATA:
                        - Textual Diff: ${textDiff.hasChanges ? 'Differences found' : 'No changes'}
                        - Visual Diff: ${totalDiffPixels} pixels total differ between the two versions.

                        TEXTUAL DIFF SNIPPET:
                        ${textDiffContext}
                        
                        I am attaching pairs of images (Version 1 and Version 2) for the pages that have visual differences.
                        
                        TASK:
                        1. Compare the pairs of images visually.
                        2. Identify what changed (e.g., layout, color, text content, highlighting).
                        3. Determine if these changes are significant for a human reader or just minor rendering artifacts.
                        
                        OUTPUT
                        Respond in the following JSON format and only in JSON. Do not add any other text.

                        {
                            "isAcceptable": boolean,
                            "reasoning": "string",
                            "similarityScore": number,
                            "pages": [
                                {
                                    "pageNum": number,
                                    "isAcceptable": boolean,
                                    "reasoning": "string"
                                }
                            ]
                        }`
                    }
                ]
            }
        ];

        const pagesToAnalyze = selectedPages.slice(0, config.maxAiPages);

        pagesToAnalyze.forEach((res) => {
            messages[0].content.push({
                type: 'text',
                text: `--- PAGE ${res.pageNum} COMPARISON ---`
            });

            // Add Image from PDF 1
            messages[0].content.push({
                type: 'text',
                text: `[Page ${res.pageNum} - Version 1]`
            });
            messages[0].content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: Buffer.from(res.page1Data).toString('base64'),
                },
            });

            // Add Image from PDF 2
            messages[0].content.push({
                type: 'text',
                text: `[Page ${res.pageNum} - Version 2]`
            });
            messages[0].content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: Buffer.from(res.page2Data).toString('base64'),
                },
            });
        });

        const response = await withTimeout(
            anthropic.messages.create({
                model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
                max_tokens: config.aiMaxTokens,
                messages,
            }),
            config.aiTimeoutMs
        );

        const raw = response.content[0].text;
        rawResponseText = raw;
        const parsed = parseClaudeJson(raw);

        console.log('\n--- Claude\'s Interpretation (Direct Vision) ---');
        console.log(raw);
        console.log('----------------------------------------------\n');

        return {
            status: 'VALID',
            error: null,
            raw,
            result: parsed,
        };
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error('Error during Claude interpretation:', message);
        if (message.includes('too large')) {
            console.error('Tip: Try reducing the number of pages sent or the scale of the images.');
        }

        if (message.startsWith('AI request timed out')) {
            return {
                status: 'TIMEOUT',
                error: message,
                raw: null,
                result: null,
            };
        }

        if (message.includes('Claude response')) {
            return {
                status: 'INVALID_RESPONSE',
                error: message,
                raw: rawResponseText ? rawResponseText.slice(0, 2000) : null,
                result: null,
            };
        }

        return {
            status: 'API_ERROR',
            error: message,
            raw: null,
            result: null,
        };
    }
}

/**
 * Execution function.
 */
async function comparePDFs(pdfPath1, pdfPath2, outputDir = 'diff_output') {
    console.log('=======================================');
    console.log('         SOCRATES PDF Vergelijking');
    console.log('=======================================');

    ensureOutputDir(outputDir);
    const startedAt = new Date();
    const phaseTimers = {
        extractionMs: 0,
        comparisonMs: 0,
        aiMs: 0,
    };

    const report = {
        status: 'ERROR',
        exitCode: EXIT_CODES.ERROR,
        inputs: {
            pdf1: pdfPath1,
            pdf2: pdfPath2,
            outputDir,
        },
        timings: {
            startedAt: startedAt.toISOString(),
            extractionMs: 0,
            comparisonMs: 0,
            aiMs: 0,
            totalMs: 0,
        },
        textDiff: {
            hasChanges: false,
            changedLineCount: 0,
            snippet: '',
            truncatedChars: 0,
        },
        visualDiff: {
            pageCount1: 0,
            pageCount2: 0,
            pageCountMismatch: false,
            pagesCompared: 0,
            totalDiffPixels: 0,
            dimensionMismatches: [],
            pages: [],
        },
        ai: {
            status: 'NOT_RUN',
            error: null,
            result: null,
        },
        policy: {
            status: 'ERROR',
            reasons: ['Comparison did not complete.'],
            exitCode: EXIT_CODES.ERROR,
        },
        artifacts: {
            reportPath: path.join(outputDir, config.reportFileName),
        },
    };

    // 1. Process PDFs
    console.log('\n[1/3] Extracting Content and Rendering Pages...');
    const extractionStart = Date.now();
    const result1 = await processPDF(pdfPath1);
    const result2 = await processPDF(pdfPath2);
    phaseTimers.extractionMs = Date.now() - extractionStart;
    report.timings.extractionMs = phaseTimers.extractionMs;
    report.visualDiff.pageCount1 = result1.pages.length;
    report.visualDiff.pageCount2 = result2.pages.length;
    report.visualDiff.pageCountMismatch = result1.pages.length !== result2.pages.length;

    // 2. Comparisons
    console.log('\n[2/3] Performing Comparisons...');
    const comparisonStart = Date.now();

    // Text Diff
    const textDiff = compareText(result1.text, result2.text);
    report.textDiff = {
        hasChanges: textDiff.hasChanges,
        changedLineCount: textDiff.changedLineCount,
        snippet: textDiff.snippet,
        truncatedChars: textDiff.truncatedChars,
    };

    if (textDiff.hasChanges) {
        console.log('Text result: Differences found.');
    } else {
        console.log('Text result: 100% identical.');
    }

    let pageNum = 1;
    let totalDiffPixels = 0;
    const pageResults = [];
    const selectedPagesForAI = [];

    const maxPages = Math.min(result1.pages.length, result2.pages.length);
    if (result1.pages.length !== result2.pages.length) {
        console.warn(`Warning: Page count mismatch (${result1.pages.length} vs ${result2.pages.length}).`);
    }

    for (let i = 0; i < maxPages; i++) {
        const page1 = result1.pages[i];
        const page2 = result2.pages[i];

        // page.data is Uint8Array from PDFParse.getScreenshot
        const img1 = PNG.sync.read(Buffer.from(page1.data));
        const img2 = PNG.sync.read(Buffer.from(page2.data));

        if (img1.width !== img2.width || img1.height !== img2.height) {
            console.warn(`Page ${pageNum}: Dimensions mismatch. Skipping visual diff.`);
            report.visualDiff.dimensionMismatches.push(pageNum);
            pageNum++;
            continue;
        }

        const { width, height } = img1;
        const diff = new PNG({ width, height });
        const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: config.pixelmatchThreshold });

        totalDiffPixels += numDiffPixels;
        let diffPath = null;

        if (numDiffPixels > 0) {
            diffPath = path.join(outputDir, `diff_page_${pageNum}.png`);
            fs.writeFileSync(diffPath, PNG.sync.write(diff));
            console.log(`Page ${pageNum}: ~${Math.round(numDiffPixels / 1000)}k pixels differ.`);
        } else {
            console.log(`Page ${pageNum}: No visual differences.`);
        }

        pageResults.push({
            pageNum,
            diffPixels: numDiffPixels,
            diffPath,
        });

        if (numDiffPixels > 0 && selectedPagesForAI.length < config.maxAiPages) {
            selectedPagesForAI.push({
                pageNum,
                diffPixels: numDiffPixels,
                page1Data: page1.data,
                page2Data: page2.data,
            });
        }

        pageNum++;
    }

    phaseTimers.comparisonMs = Date.now() - comparisonStart;
    report.timings.comparisonMs = phaseTimers.comparisonMs;
    report.visualDiff.totalDiffPixels = totalDiffPixels;
    report.visualDiff.pagesCompared = maxPages;
    report.visualDiff.pages = pageResults;

    console.log(`\nVisual comparison complete. Total diff pixels: ${totalDiffPixels}`);

    // 3. AI Interpretation
    console.log('\n[3/3] Performing AI Interpretation...');
    const aiStart = Date.now();
    const aiResult = await interpretWithClaude(totalDiffPixels, selectedPagesForAI, textDiff);
    phaseTimers.aiMs = Date.now() - aiStart;
    report.timings.aiMs = phaseTimers.aiMs;
    report.ai = aiResult;

    report.policy = evaluatePolicy(report);
    report.status = report.policy.status;
    report.exitCode = report.policy.exitCode;
    report.timings.totalMs = Date.now() - startedAt.getTime();

    fs.writeFileSync(report.artifacts.reportPath, JSON.stringify(report, null, 2));
    console.log(`Report written to: ${report.artifacts.reportPath}`);
    console.log(`Result: ${report.status} (exit code ${report.exitCode})`);

    return report;
}

// CLI handling
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Usage: node index.js <pdf1> <pdf2> [outputDir]');
        process.exit(EXIT_CODES.ERROR);
    }

    const [pdf1, pdf2, out] = args;

    try {
        validatePdfPath(pdf1, 'pdf1');
        validatePdfPath(pdf2, 'pdf2');

        const report = await comparePDFs(pdf1, pdf2, out);
        process.exit(report.exitCode);
    } catch (err) {
        console.error('Error during comparison:', err.message);
        process.exit(EXIT_CODES.ERROR);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    comparePDFs,
    compareText,
    evaluatePolicy,
    parseClaudeJson,
};
